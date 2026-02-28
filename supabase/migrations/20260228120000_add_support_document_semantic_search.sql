-- Semantic search schema for Support Hub knowledge-base documents.

create extension if not exists vector with schema extensions;

create table if not exists public.support_document_files (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'support-documents',
  brand text not null check (brand in ('omni_one', 'omni_arena')),
  storage_path text not null,
  file_name text not null,
  top_level_folder text,
  size_bytes bigint,
  storage_updated_at timestamptz,
  page_count integer,
  content_checksum text,
  indexed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, storage_path)
);

create table if not exists public.support_document_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.support_document_files(id) on delete cascade,
  brand text not null check (brand in ('omni_one', 'omni_arena')),
  storage_path text not null,
  top_level_folder text,
  chunk_index integer not null check (chunk_index >= 0),
  page_number integer check (page_number is null or page_number > 0),
  chunk_text text not null,
  token_count integer,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (file_id, chunk_index)
);

create index if not exists support_document_files_brand_idx
  on public.support_document_files (brand);

create index if not exists support_document_files_top_level_folder_idx
  on public.support_document_files (top_level_folder);

create index if not exists support_document_files_indexed_at_idx
  on public.support_document_files (indexed_at desc);

create index if not exists support_document_chunks_file_id_idx
  on public.support_document_chunks (file_id);

create index if not exists support_document_chunks_brand_idx
  on public.support_document_chunks (brand);

create index if not exists support_document_chunks_top_level_folder_idx
  on public.support_document_chunks (top_level_folder);

create index if not exists support_document_chunks_storage_path_idx
  on public.support_document_chunks (storage_path);

drop trigger if exists update_support_document_files_updated_at on public.support_document_files;
create trigger update_support_document_files_updated_at
before update on public.support_document_files
for each row
execute function public.update_updated_at_column();

drop trigger if exists update_support_document_chunks_updated_at on public.support_document_chunks;
create trigger update_support_document_chunks_updated_at
before update on public.support_document_chunks
for each row
execute function public.update_updated_at_column();

alter table public.support_document_files enable row level security;
alter table public.support_document_chunks enable row level security;

drop policy if exists "Virtuix authenticated users can read support document files" on public.support_document_files;
create policy "Virtuix authenticated users can read support document files"
on public.support_document_files
for select
using (auth.role() = 'authenticated' and public.is_virtuix_user());

drop policy if exists "Virtuix authenticated users can read support document chunks" on public.support_document_chunks;
create policy "Virtuix authenticated users can read support document chunks"
on public.support_document_chunks
for select
using (auth.role() = 'authenticated' and public.is_virtuix_user());

create or replace function public.match_support_document_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  match_brand text default null,
  match_top_level_folder text default null,
  min_similarity double precision default 0.0
)
returns table (
  chunk_id uuid,
  file_id uuid,
  brand text,
  storage_path text,
  file_name text,
  top_level_folder text,
  page_number integer,
  chunk_text text,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    chunks.id as chunk_id,
    chunks.file_id,
    chunks.brand,
    chunks.storage_path,
    files.file_name,
    chunks.top_level_folder,
    chunks.page_number,
    chunks.chunk_text,
    1 - (chunks.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.support_document_chunks as chunks
  inner join public.support_document_files as files
    on files.id = chunks.file_id
  where (match_brand is null or chunks.brand = match_brand)
    and (match_top_level_folder is null or chunks.top_level_folder = match_top_level_folder)
    and (1 - (chunks.embedding OPERATOR(extensions.<=>) query_embedding)) >= min_similarity
  order by chunks.embedding OPERATOR(extensions.<=>) query_embedding
  limit greatest(1, least(coalesce(match_count, 8), 50));
$$;

revoke all on function public.match_support_document_chunks(extensions.vector, integer, text, text, double precision) from public;
grant execute on function public.match_support_document_chunks(extensions.vector, integer, text, text, double precision) to authenticated;
grant execute on function public.match_support_document_chunks(extensions.vector, integer, text, text, double precision) to service_role;
