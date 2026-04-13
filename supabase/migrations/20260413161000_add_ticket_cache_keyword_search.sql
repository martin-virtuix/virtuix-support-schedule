-- Add database-backed keyword search over cached Hub tickets.

create extension if not exists pg_trgm with schema extensions;

alter table public.ticket_cache
  add column if not exists search_document text generated always as (
    lower(
      trim(
        ticket_id::text || ' ' ||
        coalesce(brand, '') || ' ' ||
        coalesce(status, '') || ' ' ||
        coalesce(priority, '') || ' ' ||
        coalesce(subject, '') || ' ' ||
        coalesce(requester_name, '') || ' ' ||
        coalesce(requester_email, '') || ' ' ||
        coalesce(assignee_email, '') || ' ' ||
        coalesce(summary_text, '') || ' ' ||
        coalesce(raw_payload ->> 'description', '')
      )
    )
  ) stored,
  add column if not exists search_vector tsvector generated always as (
    setweight(to_tsvector('simple', ticket_id::text), 'A') ||
    setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary_text, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(raw_payload ->> 'description', '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(requester_name, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(requester_email, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(assignee_email, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(status, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(priority, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(brand, '')), 'D')
  ) stored;

create index if not exists ticket_cache_search_document_trgm_idx
  on public.ticket_cache using gin (search_document extensions.gin_trgm_ops);

create index if not exists ticket_cache_search_vector_idx
  on public.ticket_cache using gin (search_vector);

create or replace function public.search_ticket_cache(
  search_query text,
  match_brand text default null,
  match_status text default null,
  match_limit integer default 50,
  match_offset integer default 0
)
returns table (
  ticket_id bigint,
  brand text,
  subject text,
  status text,
  priority text,
  requester_email text,
  requester_name text,
  assignee_email text,
  zendesk_updated_at timestamptz,
  ticket_url text,
  summary_text text,
  search_snippet text,
  match_score double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with normalized_input as (
    select
      trim(coalesce(search_query, '')) as raw_query,
      lower(trim(coalesce(search_query, ''))) as query_lower,
      case
        when trim(coalesce(search_query, '')) = '' then null
        else plainto_tsquery('simple', trim(coalesce(search_query, '')))
      end as ts_query,
      nullif(regexp_replace(trim(coalesce(search_query, '')), '[^0-9]', '', 'g'), '') as numeric_query
  ),
  candidate_rows as (
    select
      t.ticket_id,
      t.brand,
      t.subject,
      t.status,
      t.priority,
      t.requester_email,
      t.requester_name,
      t.assignee_email,
      t.zendesk_updated_at,
      t.ticket_url,
      t.summary_text,
      left(
        regexp_replace(
          coalesce(
            nullif(t.summary_text, ''),
            nullif(trim(t.raw_payload ->> 'description'), ''),
            t.subject
          ),
          '\s+',
          ' ',
          'g'
        ),
        280
      ) as search_snippet,
      (
        case
          when i.numeric_query is not null and t.ticket_id::text = i.numeric_query then 100
          else 0
        end
        + case
          when i.query_lower <> '' and lower(t.subject) like '%' || i.query_lower || '%' then 25
          else 0
        end
        + case
          when i.query_lower <> '' and lower(coalesce(t.summary_text, '')) like '%' || i.query_lower || '%' then 10
          else 0
        end
        + case
          when i.query_lower <> '' and lower(coalesce(t.raw_payload ->> 'description', '')) like '%' || i.query_lower || '%' then 8
          else 0
        end
        + case
          when i.ts_query is not null then ts_rank_cd(t.search_vector, i.ts_query) * 10
          else 0
        end
        + case
          when i.query_lower <> '' then similarity(t.search_document, i.query_lower) * 4
          else 0
        end
      )::double precision as match_score
    from public.ticket_cache as t
    cross join normalized_input as i
    where i.raw_query <> ''
      and (match_brand is null or t.brand = match_brand)
      and (match_status is null or t.status = match_status)
      and (
        (i.numeric_query is not null and t.ticket_id::text = i.numeric_query)
        or (i.ts_query is not null and t.search_vector @@ i.ts_query)
        or (i.query_lower <> '' and t.search_document like '%' || i.query_lower || '%')
        or (i.query_lower <> '' and t.search_document % i.query_lower)
      )
  )
  select
    ticket_id,
    brand,
    subject,
    status,
    priority,
    requester_email,
    requester_name,
    assignee_email,
    zendesk_updated_at,
    ticket_url,
    summary_text,
    search_snippet,
    round(match_score::numeric, 4)::double precision as match_score
  from candidate_rows
  order by match_score desc, zendesk_updated_at desc nulls last, ticket_id desc
  limit greatest(1, least(coalesce(match_limit, 50), 100))
  offset greatest(coalesce(match_offset, 0), 0);
$$;

revoke all on function public.search_ticket_cache(text, text, text, integer, integer) from public;
grant execute on function public.search_ticket_cache(text, text, text, integer, integer) to authenticated;
grant execute on function public.search_ticket_cache(text, text, text, integer, integer) to service_role;
