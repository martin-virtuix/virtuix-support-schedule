-- Support copilot data model: synced ticket cache, per-ticket summaries, and generated digests.

CREATE TABLE IF NOT EXISTS public.ticket_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id BIGINT NOT NULL UNIQUE,
  brand TEXT NOT NULL DEFAULT 'unknown',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT,
  requester_email TEXT,
  requester_name TEXT,
  assignee_email TEXT,
  zendesk_created_at TIMESTAMPTZ,
  zendesk_updated_at TIMESTAMPTZ,
  ticket_url TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_text TEXT,
  summary_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ticket_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id BIGINT NOT NULL UNIQUE REFERENCES public.ticket_cache(ticket_id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  key_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  ticket_ids BIGINT[] NOT NULL DEFAULT '{}',
  content_markdown TEXT NOT NULL,
  content_table JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.digest_tickets (
  digest_id UUID NOT NULL REFERENCES public.digests(id) ON DELETE CASCADE,
  ticket_id BIGINT NOT NULL REFERENCES public.ticket_cache(ticket_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS ticket_cache_brand_idx ON public.ticket_cache (brand);
CREATE INDEX IF NOT EXISTS ticket_cache_status_idx ON public.ticket_cache (status);
CREATE INDEX IF NOT EXISTS ticket_cache_updated_idx ON public.ticket_cache (zendesk_updated_at DESC);
CREATE INDEX IF NOT EXISTS ticket_cache_summary_updated_idx ON public.ticket_cache (summary_updated_at DESC);

CREATE INDEX IF NOT EXISTS ticket_summaries_updated_idx ON public.ticket_summaries (updated_at DESC);

CREATE INDEX IF NOT EXISTS digests_created_at_idx ON public.digests (created_at DESC);
CREATE INDEX IF NOT EXISTS digests_source_idx ON public.digests (source);

CREATE INDEX IF NOT EXISTS digest_tickets_ticket_idx ON public.digest_tickets (ticket_id);

DROP TRIGGER IF EXISTS update_ticket_cache_updated_at ON public.ticket_cache;
CREATE TRIGGER update_ticket_cache_updated_at
BEFORE UPDATE ON public.ticket_cache
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_ticket_summaries_updated_at ON public.ticket_summaries;
CREATE TRIGGER update_ticket_summaries_updated_at
BEFORE UPDATE ON public.ticket_summaries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_digests_updated_at ON public.digests;
CREATE TRIGGER update_digests_updated_at
BEFORE UPDATE ON public.digests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.is_virtuix_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((auth.jwt() ->> 'email') ILIKE '%@virtuix.com', false);
$$;

ALTER TABLE public.ticket_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Virtuix authenticated users can read ticket cache" ON public.ticket_cache;
CREATE POLICY "Virtuix authenticated users can read ticket cache"
ON public.ticket_cache
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());

DROP POLICY IF EXISTS "Virtuix authenticated users can read ticket summaries" ON public.ticket_summaries;
CREATE POLICY "Virtuix authenticated users can read ticket summaries"
ON public.ticket_summaries
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());

DROP POLICY IF EXISTS "Virtuix authenticated users can read digests" ON public.digests;
CREATE POLICY "Virtuix authenticated users can read digests"
ON public.digests
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());

DROP POLICY IF EXISTS "Virtuix authenticated users can read digest tickets" ON public.digest_tickets;
CREATE POLICY "Virtuix authenticated users can read digest tickets"
ON public.digest_tickets
FOR SELECT
USING (auth.role() = 'authenticated' AND public.is_virtuix_user());
