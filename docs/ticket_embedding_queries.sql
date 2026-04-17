-- Ticket embedding inspection queries
--
-- Purpose:
--   Handy SQL snippets for validating v1 ticket-summary embeddings in Supabase.
--
-- Main tables:
--   public.ticket_cache
--   public.ticket_embedding_chunks
--
-- Notes:
--   - v1 stores one summary embedding row per ticket with source = 'summary'.
--   - Good rows should use the canonical format:
--       Issue:
--       Troubleshooting:
--       Resolution:
--   - Legacy rows should not be present in the embedding table.


-- ============================================================================
-- 1. Coverage summary
-- ============================================================================

select
  (select count(*)
   from public.ticket_cache
   where status not in ('spam', 'deleted')) as active_tickets,
  (select count(*)
   from public.ticket_cache
   where status not in ('spam', 'deleted')
     and summary_text is not null) as summarized_tickets,
  (select count(*)
   from public.ticket_cache
   where status not in ('spam', 'deleted')
     and summary_text like 'Issue:%'
     and summary_text like '%Troubleshooting:%'
     and summary_text like '%Resolution:%') as canonical_summaries,
  (select count(distinct ticket_id)
   from public.ticket_embedding_chunks
   where source = 'summary') as embedded_tickets,
  (select count(*)
   from public.ticket_embedding_chunks
   where source = 'summary') as embedding_rows;


-- ============================================================================
-- 2. Embedded ticket list
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  ticket_url,
  zendesk_updated_at,
  summary_updated_at,
  embedded_at
from public.ticket_embedding_chunks
where source = 'summary'
order by embedded_at desc;


-- ============================================================================
-- 3. Embedded ticket list with summary preview
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  left(content_text, 500) as summary_preview,
  embedded_at
from public.ticket_embedding_chunks
where source = 'summary'
order by embedded_at desc;


-- ============================================================================
-- 4. Full embedded text for one ticket
--   Replace 17300 with the ticket id you want to inspect.
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  content_text,
  embedded_at
from public.ticket_embedding_chunks
where source = 'summary'
  and ticket_id = 17300;


-- ============================================================================
-- 5. Quality check: legacy-format rows should be zero
-- ============================================================================

select count(*) as legacy_rows
from public.ticket_embedding_chunks
where source = 'summary'
  and (
    content_text like 'Ticket Subject:%'
    or content_text like '%Requester:%'
    or content_text like '%Issue Summary:%'
    or content_text like '%Support Actions:%'
    or content_text like '%Recommended Next Step:%'
    or content_text like '%Next Steps%'
  );


-- ============================================================================
-- 6. Quality check: rows missing canonical sections
-- ============================================================================

select count(*) as noncanonical_rows
from public.ticket_embedding_chunks
where source = 'summary'
  and (
    content_text not like 'Issue:%'
    or content_text not like '%Troubleshooting:%'
    or content_text not like '%Resolution:%'
  );


-- ============================================================================
-- 7. Inspect any legacy or noncanonical rows directly
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  content_text,
  embedded_at
from public.ticket_embedding_chunks
where source = 'summary'
  and (
    content_text like 'Ticket Subject:%'
    or content_text like '%Requester:%'
    or content_text like '%Issue Summary:%'
    or content_text like '%Support Actions:%'
    or content_text like '%Recommended Next Step:%'
    or content_text like '%Next Steps%'
    or content_text not like 'Issue:%'
    or content_text not like '%Troubleshooting:%'
    or content_text not like '%Resolution:%'
  )
order by embedded_at desc;


-- ============================================================================
-- 8. Duplicate check: v1 should have one summary row per ticket
-- ============================================================================

select
  ticket_id,
  count(*) as row_count
from public.ticket_embedding_chunks
where source = 'summary'
group by ticket_id
having count(*) > 1
order by row_count desc, ticket_id desc;


-- ============================================================================
-- 9. Coverage view: ticket_cache vs embedding status
-- ============================================================================

select
  tc.ticket_id,
  tc.brand,
  tc.status,
  tc.subject,
  tc.summary_updated_at,
  tc.zendesk_updated_at,
  case
    when te.ticket_id is not null then true
    else false
  end as is_embedded,
  te.embedded_at,
  left(tc.summary_text, 300) as summary_preview
from public.ticket_cache tc
left join (
  select
    ticket_id,
    max(embedded_at) as embedded_at
  from public.ticket_embedding_chunks
  where source = 'summary'
  group by ticket_id
) te
  on te.ticket_id = tc.ticket_id
where tc.status not in ('spam', 'deleted')
order by is_embedded desc, tc.summary_updated_at desc nulls last, tc.ticket_id desc;


-- ============================================================================
-- 10. Tickets not embedded yet
-- ============================================================================

select
  tc.ticket_id,
  tc.brand,
  tc.status,
  tc.subject,
  tc.summary_updated_at,
  tc.zendesk_updated_at,
  left(tc.summary_text, 300) as summary_preview
from public.ticket_cache tc
left join (
  select distinct ticket_id
  from public.ticket_embedding_chunks
  where source = 'summary'
) te
  on te.ticket_id = tc.ticket_id
where tc.status not in ('spam', 'deleted')
  and te.ticket_id is null
order by tc.summary_updated_at desc nulls last, tc.ticket_id desc;


-- ============================================================================
-- 11. Embedded tickets only, joined to ticket_cache
-- ============================================================================

select
  tc.ticket_id,
  tc.brand,
  tc.status,
  tc.subject,
  te.embedded_at,
  left(te.content_text, 300) as embedded_preview
from public.ticket_cache tc
join public.ticket_embedding_chunks te
  on te.ticket_id = tc.ticket_id
where te.source = 'summary'
order by te.embedded_at desc;


-- ============================================================================
-- 12. Freshness check: embeddings older than their current summary
--   These are candidates for reindexing.
-- ============================================================================

select
  te.ticket_id,
  te.brand,
  te.status,
  te.subject,
  te.summary_updated_at as embedded_summary_updated_at,
  tc.summary_updated_at as current_summary_updated_at,
  te.embedded_at
from public.ticket_embedding_chunks te
join public.ticket_cache tc
  on tc.ticket_id = te.ticket_id
where te.source = 'summary'
  and tc.summary_updated_at is not null
  and te.summary_updated_at is not null
  and te.summary_updated_at < tc.summary_updated_at
order by tc.summary_updated_at desc, te.embedded_at asc;


-- ============================================================================
-- 13. Freshness check: summaries older than Zendesk updates
--   These are candidates for summary refresh before reindexing.
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  summary_updated_at,
  zendesk_updated_at,
  left(summary_text, 300) as summary_preview
from public.ticket_cache
where status not in ('spam', 'deleted')
  and summary_text is not null
  and summary_updated_at is not null
  and zendesk_updated_at is not null
  and summary_updated_at < zendesk_updated_at
order by zendesk_updated_at desc;


-- ============================================================================
-- 14. Brand breakdown for embeddings
-- ============================================================================

select
  brand,
  count(distinct ticket_id) as embedded_tickets,
  count(*) as embedding_rows
from public.ticket_embedding_chunks
where source = 'summary'
group by brand
order by embedded_tickets desc, brand asc;


-- ============================================================================
-- 15. Status breakdown for embeddings
-- ============================================================================

select
  status,
  count(distinct ticket_id) as embedded_tickets,
  count(*) as embedding_rows
from public.ticket_embedding_chunks
where source = 'summary'
group by status
order by embedded_tickets desc, status asc;


-- ============================================================================
-- 16. Oldest and newest embedding timestamps
-- ============================================================================

select
  min(embedded_at) as first_embedded_at,
  max(embedded_at) as last_embedded_at
from public.ticket_embedding_chunks
where source = 'summary';


-- ============================================================================
-- 17. Recent embedding activity
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  embedded_at
from public.ticket_embedding_chunks
where source = 'summary'
order by embedded_at desc
limit 100;


-- ============================================================================
-- 18. Largest embedded summaries by token count
-- ============================================================================

select
  ticket_id,
  brand,
  status,
  subject,
  token_count,
  left(content_text, 300) as summary_preview
from public.ticket_embedding_chunks
where source = 'summary'
order by token_count desc nulls last, ticket_id desc
limit 50;


-- ============================================================================
-- 19. Coverage percentage
-- ============================================================================

with coverage as (
  select
    (select count(*)
     from public.ticket_cache
     where status not in ('spam', 'deleted')
       and summary_text like 'Issue:%'
       and summary_text like '%Troubleshooting:%'
       and summary_text like '%Resolution:%') as canonical_summaries,
    (select count(distinct ticket_id)
     from public.ticket_embedding_chunks
     where source = 'summary') as embedded_tickets
)
select
  canonical_summaries,
  embedded_tickets,
  case
    when canonical_summaries = 0 then 0
    else round((embedded_tickets::numeric / canonical_summaries::numeric) * 100, 2)
  end as pct_of_canonical_summaries_embedded
from coverage;


-- ============================================================================
-- 20. Direct list of canonical summaries that still are not embedded
-- ============================================================================

select
  tc.ticket_id,
  tc.brand,
  tc.status,
  tc.subject,
  tc.summary_updated_at,
  left(tc.summary_text, 400) as canonical_summary_preview
from public.ticket_cache tc
left join (
  select distinct ticket_id
  from public.ticket_embedding_chunks
  where source = 'summary'
) te
  on te.ticket_id = tc.ticket_id
where tc.status not in ('spam', 'deleted')
  and tc.summary_text like 'Issue:%'
  and tc.summary_text like '%Troubleshooting:%'
  and tc.summary_text like '%Resolution:%'
  and te.ticket_id is null
order by tc.summary_updated_at desc nulls last, tc.ticket_id desc;
