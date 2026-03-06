-- Usage analytics events + baseline summary for Support Hub product instrumentation.

create table if not exists public.hub_analytics_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  user_id uuid,
  user_email text,
  route text,
  event_name text not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists hub_analytics_events_occurred_idx
  on public.hub_analytics_events (occurred_at desc);

create index if not exists hub_analytics_events_event_name_idx
  on public.hub_analytics_events (event_name);

create index if not exists hub_analytics_events_user_email_idx
  on public.hub_analytics_events (user_email);

alter table public.hub_analytics_events enable row level security;

drop policy if exists "Virtuix authenticated users can read hub analytics events" on public.hub_analytics_events;
create policy "Virtuix authenticated users can read hub analytics events"
on public.hub_analytics_events
for select
using (auth.role() = 'authenticated' and public.is_virtuix_user());

create or replace function public.get_hub_analytics_baseline(period_days integer default 14)
returns table (
  period_start_date date,
  period_end_date date,
  total_events integer,
  unique_users integer,
  copilot_queries integer,
  citation_clicks integer,
  weekly_reports_refreshed integer,
  rollup_reports_refreshed integer,
  sql_reports_generated integer
)
language sql
stable
set search_path = public
as $$
  with params as (
    select
      greatest(coalesce(period_days, 14), 1)::integer as days,
      (now() at time zone 'utc')::date as end_date
  ),
  window_bounds as (
    select
      (p.end_date - (p.days - 1))::date as start_date,
      p.end_date as end_date
    from params as p
  ),
  filtered as (
    select
      e.event_name,
      e.user_email
    from public.hub_analytics_events as e
    cross join window_bounds as w
    where (e.occurred_at at time zone 'utc')::date >= w.start_date
      and (e.occurred_at at time zone 'utc')::date <= w.end_date
  )
  select
    w.start_date as period_start_date,
    w.end_date as period_end_date,
    count(f.*)::integer as total_events,
    count(distinct f.user_email)::integer as unique_users,
    count(*) filter (where f.event_name = 'copilot_query_completed')::integer as copilot_queries,
    count(*) filter (where f.event_name = 'copilot_citation_clicked')::integer as citation_clicks,
    count(*) filter (where f.event_name = 'weekly_report_refreshed')::integer as weekly_reports_refreshed,
    count(*) filter (where f.event_name = 'received_rollup_refreshed')::integer as rollup_reports_refreshed,
    count(*) filter (where f.event_name = 'sql_import_report_generated')::integer as sql_reports_generated
  from window_bounds as w
  left join filtered as f
    on true
  group by w.start_date, w.end_date;
$$;

revoke all on function public.get_hub_analytics_baseline(integer) from public;
grant execute on function public.get_hub_analytics_baseline(integer) to authenticated;
grant execute on function public.get_hub_analytics_baseline(integer) to service_role;
