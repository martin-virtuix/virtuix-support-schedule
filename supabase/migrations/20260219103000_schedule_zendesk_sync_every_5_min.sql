-- Schedule automatic Zendesk sync every 5 minutes via pg_cron
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Ensure idempotency: remove previous job with same name if it exists
DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  SELECT jobid
  INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'zendesk-sync-every-5-minutes'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;
END;
$$;

SELECT cron.schedule(
  'zendesk-sync-every-5-minutes',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ddqacivmenvlidzxxhyv.supabase.co/functions/v1/zendesk-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{"brand":"all"}'::jsonb
  ) AS request_id;
  $$
);
