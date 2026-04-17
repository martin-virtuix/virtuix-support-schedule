-- Semantic search schema for summarized support tickets.

create extension if not exists vector with schema extensions;

create table if not exists public.ticket_embedding_chunks (
  id uuid primary key default gen_random_uuid(),
  ticket_id bigint not null references public.ticket_cache(ticket_id) on delete cascade,
  brand text not null,
  status text not null,
  subject text not null default '',
  ticket_url text,
  zendesk_updated_at timestamptz,
  summary_updated_at timestamptz,
  source text not null default 'summary',
  chunk_index integer not null default 0 check (chunk_index >= 0),
  content_text text not null,
  content_checksum text,
  token_count integer,
  embedding extensions.vector(1536) not null,
  embedded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ticket_id, source, chunk_index)
);

create index if not exists ticket_embedding_chunks_ticket_id_idx
  on public.ticket_embedding_chunks (ticket_id);

create index if not exists ticket_embedding_chunks_brand_idx
  on public.ticket_embedding_chunks (brand);

create index if not exists ticket_embedding_chunks_status_idx
  on public.ticket_embedding_chunks (status);

create index if not exists ticket_embedding_chunks_updated_idx
  on public.ticket_embedding_chunks (summary_updated_at desc, zendesk_updated_at desc);

create index if not exists ticket_embedding_chunks_embedded_at_idx
  on public.ticket_embedding_chunks (embedded_at desc);

drop trigger if exists update_ticket_embedding_chunks_updated_at on public.ticket_embedding_chunks;
create trigger update_ticket_embedding_chunks_updated_at
before update on public.ticket_embedding_chunks
for each row
execute function public.update_updated_at_column();

alter table public.ticket_embedding_chunks enable row level security;

drop policy if exists "Virtuix authenticated users can read ticket embedding chunks" on public.ticket_embedding_chunks;
create policy "Virtuix authenticated users can read ticket embedding chunks"
on public.ticket_embedding_chunks
for select
using (auth.role() = 'authenticated' and public.is_virtuix_user());

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
    and (match_brand is null or chunks.brand = match_brand)
    and (match_status is null or chunks.status = match_status)
    and (1 - (chunks.embedding OPERATOR(extensions.<=>) query_embedding)) >= min_similarity
  order by chunks.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1, least(coalesce(match_count, 8), 50));
$$;

revoke all on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) from public;
grant execute on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) to authenticated;
grant execute on function public.match_ticket_embedding_chunks(extensions.vector, integer, text, text, double precision) to service_role;
