-- Schedule weekly support report dispatch every Monday at 7:00 AM CST.
-- 7:00 AM CST == 13:00 UTC.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'weekly-ticket-report-monday-7am-cst'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'weekly-ticket-report-monday-7am-cst',
  '0 13 * * 1',
  $$
  select net.http_post(
    url := 'https://ddqacivmenvlidzxxhyv.supabase.co/functions/v1/weekly_ticket_report_dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
