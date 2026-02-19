-- Prevent overlapping Zendesk sync jobs

-- Mark stale running jobs as error to avoid blocking future runs forever
UPDATE public.zendesk_sync_runs
SET
  status = 'error',
  finished_at = COALESCE(finished_at, now()),
  error_message = COALESCE(error_message, 'Marked stale by migration: exceeded 30 minutes in running state')
WHERE status = 'running'
  AND started_at < now() - interval '30 minutes';

-- Enforce at most one running row at a time
CREATE UNIQUE INDEX IF NOT EXISTS zendesk_sync_runs_single_running_idx
ON public.zendesk_sync_runs ((status))
WHERE status = 'running';
