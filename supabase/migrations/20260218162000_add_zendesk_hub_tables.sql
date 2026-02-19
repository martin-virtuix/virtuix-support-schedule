-- Zendesk ticket storage for Support Hub
CREATE TABLE public.zendesk_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id BIGINT NOT NULL UNIQUE,
  brand TEXT NOT NULL DEFAULT 'unknown',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT,
  requester_email TEXT,
  assignee_email TEXT,
  zendesk_created_at TIMESTAMPTZ,
  zendesk_updated_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX zendesk_tickets_brand_idx ON public.zendesk_tickets (brand);
CREATE INDEX zendesk_tickets_status_idx ON public.zendesk_tickets (status);
CREATE INDEX zendesk_tickets_zendesk_updated_at_idx ON public.zendesk_tickets (zendesk_updated_at DESC);

CREATE TRIGGER update_zendesk_tickets_updated_at
BEFORE UPDATE ON public.zendesk_tickets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Tracks every sync execution for observability and incremental cursor management
CREATE TABLE public.zendesk_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  tickets_fetched INTEGER NOT NULL DEFAULT 0 CHECK (tickets_fetched >= 0),
  tickets_upserted INTEGER NOT NULL DEFAULT 0 CHECK (tickets_upserted >= 0),
  cursor BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX zendesk_sync_runs_status_idx ON public.zendesk_sync_runs (status);
CREATE INDEX zendesk_sync_runs_started_at_idx ON public.zendesk_sync_runs (started_at DESC);

CREATE OR REPLACE FUNCTION public.is_virtuix_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((auth.jwt() ->> 'email') ILIKE '%@virtuix.com', false);
$$;

ALTER TABLE public.zendesk_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zendesk_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Virtuix authenticated users can read Zendesk tickets"
ON public.zendesk_tickets
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());

CREATE POLICY "Virtuix authenticated users can read Zendesk sync runs"
ON public.zendesk_sync_runs
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());
