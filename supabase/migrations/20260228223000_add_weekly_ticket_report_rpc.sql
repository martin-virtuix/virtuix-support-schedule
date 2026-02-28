-- Weekly ticket report RPC for /hub/reports.
-- Focus: received in period vs solved/closed vs still open.
-- Excludes spam/deleted tickets from all counts.

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
      and t.zendesk_created_at >= p.start_date::timestamp
      and t.zendesk_created_at < (p.start_date + p.days)::timestamp
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
