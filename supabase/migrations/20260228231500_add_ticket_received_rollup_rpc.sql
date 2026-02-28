-- Monthly / quarterly / yearly received-ticket rollup for /hub/reports.
-- Excludes spam/deleted tickets.

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
      t.zendesk_created_at,
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
        where f.zendesk_created_at >= w.start_date::timestamp
          and f.zendesk_created_at < (w.end_date + 1)::timestamp
          and (b.brand = 'total' or f.normalized_brand = b.brand)
      )::integer as current_count,
      count(*) filter (
        where f.zendesk_created_at >= w.previous_start_date::timestamp
          and f.zendesk_created_at < (w.previous_end_date + 1)::timestamp
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
