-- Harden report date filtering and add coverage diagnostics for ticket intake reliability.

create index if not exists ticket_cache_created_idx on public.ticket_cache (zendesk_created_at);

create or replace function public.get_weekly_ticket_report(
  period_start date default null,
  period_days integer default 7
)
returns table (
  period_start_date date,
  period_end_date date,
  brand text,
  received_count integer,
  solved_closed_count integer,
  still_open_count integer,
  resolution_rate double precision
)
language sql
stable
set search_path = public
as $$
  with params as (
    select
      coalesce(period_start, date_trunc('week', now() at time zone 'utc')::date) as start_date,
      greatest(coalesce(period_days, 7), 1) as days
  ),
  normalized as (
    select
      case
        when lower(coalesce(t.brand, '')) in ('omni_one', 'omni_arena') then lower(t.brand)
        else 'other'
      end as normalized_brand,
      lower(trim(coalesce(t.status, ''))) as normalized_status
    from public.ticket_cache as t
    cross join params as p
    where t.zendesk_created_at is not null
      and (t.zendesk_created_at at time zone 'utc') >= p.start_date::timestamp
      and (t.zendesk_created_at at time zone 'utc') < (p.start_date + p.days)::timestamp
      and lower(trim(coalesce(t.status, ''))) not in ('spam', 'deleted')
  ),
  brand_buckets as (
    select unnest(array['omni_one', 'omni_arena', 'other']) as brand
  ),
  brand_counts as (
    select
      b.brand,
      coalesce(count(n.*), 0)::integer as received_count,
      coalesce(count(*) filter (where n.normalized_status in ('solved', 'closed')), 0)::integer as solved_closed_count,
      coalesce(count(*) filter (where n.normalized_status not in ('solved', 'closed')), 0)::integer as still_open_count
    from brand_buckets as b
    left join normalized as n
      on n.normalized_brand = b.brand
    group by b.brand
  ),
  totals as (
    select
      'total'::text as brand,
      sum(received_count)::integer as received_count,
      sum(solved_closed_count)::integer as solved_closed_count,
      sum(still_open_count)::integer as still_open_count
    from brand_counts
  ),
  final_counts as (
    select * from brand_counts
    union all
    select * from totals
  )
  select
    p.start_date as period_start_date,
    (p.start_date + p.days - 1) as period_end_date,
    f.brand,
    f.received_count,
    f.solved_closed_count,
    f.still_open_count,
    case
      when f.received_count = 0 then 0
      else f.solved_closed_count::double precision / f.received_count::double precision
    end as resolution_rate
  from final_counts as f
  cross join params as p
  order by
    case f.brand
      when 'total' then 0
      when 'omni_one' then 1
      when 'omni_arena' then 2
      else 3
    end;
$$;

revoke all on function public.get_weekly_ticket_report(date, integer) from public;
grant execute on function public.get_weekly_ticket_report(date, integer) to authenticated;
grant execute on function public.get_weekly_ticket_report(date, integer) to service_role;

create or replace function public.get_ticket_received_rollup(
  reference_date date default null
)
returns table (
  period_type text,
  period_start_date date,
  period_end_date date,
  brand text,
  received_count integer,
  previous_period_start_date date,
  previous_period_end_date date,
  previous_received_count integer,
  delta integer,
  delta_pct double precision
)
language sql
stable
set search_path = public
as $$
  with ref as (
    select coalesce(reference_date, (now() at time zone 'utc')::date) as d
  ),
  periods as (
    select
      'month'::text as period_type,
      date_trunc('month', d::timestamp)::date as start_date,
      (date_trunc('month', d::timestamp) + interval '1 month')::date as next_start_date
    from ref
    union all
    select
      'quarter'::text as period_type,
      date_trunc('quarter', d::timestamp)::date as start_date,
      (date_trunc('quarter', d::timestamp) + interval '3 month')::date as next_start_date
    from ref
    union all
    select
      'year'::text as period_type,
      date_trunc('year', d::timestamp)::date as start_date,
      (date_trunc('year', d::timestamp) + interval '1 year')::date as next_start_date
    from ref
  ),
  period_windows as (
    select
      p.period_type,
      p.start_date,
      (p.next_start_date - 1) as end_date,
      case p.period_type
        when 'month' then (p.start_date - interval '1 month')::date
        when 'quarter' then (p.start_date - interval '3 month')::date
        when 'year' then (p.start_date - interval '1 year')::date
        else (p.start_date - interval '1 month')::date
      end as previous_start_date
    from periods as p
  ),
  period_windows_with_prev_end as (
    select
      period_type,
      start_date,
      end_date,
      previous_start_date,
      (start_date - interval '1 day')::date as previous_end_date
    from period_windows
  ),
  brand_buckets as (
    select unnest(array['total', 'omni_one', 'omni_arena', 'other']) as brand
  ),
  filtered_tickets as (
    select
      (t.zendesk_created_at at time zone 'utc')::date as created_date,
      case
        when lower(coalesce(t.brand, '')) in ('omni_one', 'omni_arena') then lower(t.brand)
        else 'other'
      end as normalized_brand
    from public.ticket_cache as t
    where t.zendesk_created_at is not null
      and lower(trim(coalesce(t.status, ''))) not in ('spam', 'deleted')
  ),
  counts as (
    select
      w.period_type,
      w.start_date,
      w.end_date,
      w.previous_start_date,
      w.previous_end_date,
      b.brand,
      count(*) filter (
        where f.created_date >= w.start_date
          and f.created_date <= w.end_date
          and (b.brand = 'total' or f.normalized_brand = b.brand)
      )::integer as current_count,
      count(*) filter (
        where f.created_date >= w.previous_start_date
          and f.created_date <= w.previous_end_date
          and (b.brand = 'total' or f.normalized_brand = b.brand)
      )::integer as previous_count
    from period_windows_with_prev_end as w
    cross join brand_buckets as b
    left join filtered_tickets as f on true
    group by
      w.period_type,
      w.start_date,
      w.end_date,
      w.previous_start_date,
      w.previous_end_date,
      b.brand
  )
  select
    c.period_type,
    c.start_date as period_start_date,
    c.end_date as period_end_date,
    c.brand,
    c.current_count as received_count,
    c.previous_start_date as previous_period_start_date,
    c.previous_end_date as previous_period_end_date,
    c.previous_count as previous_received_count,
    (c.current_count - c.previous_count) as delta,
    case
      when c.previous_count = 0 then null
      else (c.current_count - c.previous_count)::double precision / c.previous_count::double precision
    end as delta_pct
  from counts as c
  order by
    case c.period_type
      when 'month' then 1
      when 'quarter' then 2
      when 'year' then 3
      else 99
    end,
    case c.brand
      when 'total' then 1
      when 'omni_one' then 2
      when 'omni_arena' then 3
      else 4
    end;
$$;

revoke all on function public.get_ticket_received_rollup(date) from public;
grant execute on function public.get_ticket_received_rollup(date) to authenticated;
grant execute on function public.get_ticket_received_rollup(date) to service_role;

create or replace function public.get_ticket_data_coverage()
returns table (
  earliest_created_at timestamptz,
  latest_created_at timestamptz,
  total_tickets integer,
  tickets_with_created_at integer,
  tickets_missing_created_at integer,
  latest_sync_started_at timestamptz,
  latest_sync_finished_at timestamptz,
  latest_sync_status text,
  latest_sync_cursor bigint,
  latest_sync_error text
)
language sql
stable
set search_path = public
as $$
  with coverage as (
    select
      min(zendesk_created_at) as earliest_created_at,
      max(zendesk_created_at) as latest_created_at,
      count(*)::integer as total_tickets,
      count(*) filter (where zendesk_created_at is not null)::integer as tickets_with_created_at,
      count(*) filter (where zendesk_created_at is null)::integer as tickets_missing_created_at
    from public.ticket_cache
  ),
  latest_run as (
    select
      started_at,
      finished_at,
      status,
      cursor,
      error_message
    from public.zendesk_sync_runs
    order by started_at desc
    limit 1
  )
  select
    c.earliest_created_at,
    c.latest_created_at,
    c.total_tickets,
    c.tickets_with_created_at,
    c.tickets_missing_created_at,
    lr.started_at as latest_sync_started_at,
    lr.finished_at as latest_sync_finished_at,
    lr.status as latest_sync_status,
    lr.cursor as latest_sync_cursor,
    lr.error_message as latest_sync_error
  from coverage as c
  left join latest_run as lr
    on true;
$$;

revoke all on function public.get_ticket_data_coverage() from public;
grant execute on function public.get_ticket_data_coverage() to authenticated;
grant execute on function public.get_ticket_data_coverage() to service_role;
