-- Restrict ticket semantic search to canonical embedding summaries only.

create or replace function public.match_ticket_embedding_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  match_brand text default null,
  match_status text default null,
  min_similarity double precision default 0.0
)
returns table (
  chunk_id uuid,
  ticket_id bigint,
  brand text,
  status text,
  subject text,
  ticket_url text,
  zendesk_updated_at timestamptz,
  source text,
  chunk_index integer,
  content_text text,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    chunks.id as chunk_id,
    chunks.ticket_id,
    chunks.brand,
    chunks.status,
    chunks.subject,
    chunks.ticket_url,
    chunks.zendesk_updated_at,
    chunks.source,
    chunks.chunk_index,
    chunks.content_text,
    1 - (chunks.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.ticket_embedding_chunks as chunks
  where chunks.status not in ('spam', 'deleted')
    and chunks.content_text like 'Issue:%'
    and chunks.content_text like '%Troubleshooting:%'
    and chunks.content_text like '%Resolution:%'
    and chunks.content_text not like 'Ticket Subject:%'
    and chunks.content_text not like '%Requester:%'
    and chunks.content_text not like '%Recommended Next Step:%'
    and (match_brand is null or chunks.brand = match_brand)
    and (match_status is null or chunks.status = match_status)
    and (1 - (chunks.embedding OPERATOR(extensions.<=>) query_embedding)) >= min_similarity
  order by chunks.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1, least(coalesce(match_count, 8), 50));
$$;

revoke all on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) from public;
grant execute on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) to authenticated;
grant execute on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) to service_role;
