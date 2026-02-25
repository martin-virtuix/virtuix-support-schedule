-- Route scheduled sync to the active sync_zendesk pipeline used by /hub (ticket_cache).
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  FOR existing_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN ('zendesk-sync-every-5-minutes', 'sync-zendesk-every-5-minutes')
  LOOP
    PERFORM cron.unschedule(existing_job_id);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'sync-zendesk-every-5-minutes',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ddqacivmenvlidzxxhyv.supabase.co/functions/v1/sync_zendesk',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{"brand":"all"}'::jsonb
  ) AS request_id;
  $$
);
