# Ticket Embedding Status

Last updated: 2026-04-22

## Purpose

This file is a handoff note for the ticket-summary embedding work. It summarizes what is already implemented in the repo, what is still operationally unknown, and the safest way to resume the job.

## What Has Been Implemented

### 1. Canonical ticket-summary format

`supabase/functions/summarize_ticket/index.ts` now normalizes AI output into a canonical retrieval-oriented format before storing it:

- `Issue:`
- `Troubleshooting:`
- `Resolution:`

The summarizer prompt may ask the model for `Resolution Status` and `Resolution Details`, but the function rewrites the stored result into the final `Resolution:` block. This keeps the summary format aligned with the backfill classifier, embedding indexer, and Copilot semantic filters.

### 2. Ticket embedding schema and RPC

Implemented in:

- `supabase/migrations/20260416190000_add_ticket_summary_semantic_search.sql`
- `supabase/migrations/20260416201500_filter_ticket_semantic_search_to_canonical_summaries.sql`

This work added:

- pgvector enablement in the `extensions` schema
- `public.ticket_embedding_chunks`
- supporting indexes and RLS
- `public.match_ticket_embedding_chunks(...)`
- canonical-summary filtering at the RPC level

### 3. Summary backfill runner

Implemented in `scripts/backfill_ticket_summaries.py`.

Capabilities:

- reads from `ticket_cache`
- classifies summaries as:
  - missing
  - legacy
  - noncanonical
  - stale
- refreshes summaries through the deployed `summarize_ticket` function
- supports retries, bounded concurrency, dry runs, and ticket-id targeting

Key targeting options:

- `--ticket-id`
- `--ticket-id-min`
- `--ticket-id-max`
- `--brand`
- `--order`
- `--max-tickets`
- `--include-stale`
- `--force`

### 4. Embedding indexer

Implemented in `scripts/index_ticket_summaries.py`.

Capabilities:

- reads summarized tickets from `ticket_cache`
- indexes only canonical summaries
- skips unchanged tickets by timestamp or checksum unless forced
- writes summary embeddings into `ticket_embedding_chunks`
- can purge existing rows for tickets whose current summary is legacy or noncanonical
- supports dry runs, batching, and ticket-id targeting

Key targeting options:

- `--ticket-id`
- `--ticket-id-min`
- `--ticket-id-max`
- `--brand`
- `--order`
- `--max-tickets`
- `--force`
- `--purge-noncanonical-existing`

### 5. Copilot ticket semantic retrieval

Implemented in `supabase/functions/copilot_chat/index.ts`.

Current behavior:

- creates a query embedding using `OPENAI_EMBEDDING_MODEL`
- calls `match_ticket_embedding_chunks(...)`
- filters matches to canonical summary content
- merges semantic ticket results with lexical ticket matches from `ticket_cache`
- returns structured citations alongside the assistant reply

## Relevant Commits

- `bf26828` - `Add ticket summary backfill and semantic ticket retrieval`
- `0819bff` - `Refine copilot UX and ticket embedding tools`

## Validation Artifacts

Validation SQL lives in:

- `docs/ticket_embedding_queries.sql`

This file contains queries for:

- overall coverage
- embedded ticket inspection
- legacy/noncanonical row checks
- duplicate checks
- freshness comparisons
- brand and status breakdowns
- list of canonical summaries still not embedded

## Current Repo State

- The ticket-embedding pipeline is implemented in source control.
- The Python scripts compile locally.
- The summarizer, classifier, indexer, migration filters, and Copilot retrieval path are internally consistent.

## What Is Still Unknown

The repo does not tell us the live Supabase operational state. Specifically, source control does not tell us:

- how many tickets already have canonical summaries
- how many tickets have already been embedded
- whether there are partial batches in `ticket_embedding_chunks`
- whether any legacy rows still exist remotely

That must be checked against the live Supabase project.

## Required Environment

### For summary backfill

Required:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Preferred auth for calling the deployed function:

```bash
SUPABASE_FUNCTION_TOKEN
```

Fallback auth options:

```bash
SUPABASE_USER_ACCESS_TOKEN
VITE_SUPABASE_PUBLISHABLE_KEY
```

### For embedding indexing

Required:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
```

Optional override:

```bash
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

## Safe Resume Workflow

### 1. Backfill dry run

```bash
python3 scripts/backfill_ticket_summaries.py --dry-run --include-stale --order desc
```

### 2. Embedding dry run

```bash
python3 scripts/index_ticket_summaries.py --dry-run --purge-noncanonical-existing --order desc
```

### 3. Run bounded live batches

Example:

```bash
python3 scripts/backfill_ticket_summaries.py --include-stale --order desc --max-tickets 100
python3 scripts/index_ticket_summaries.py --purge-noncanonical-existing --order desc --max-tickets 100
```

### 4. Validate coverage and freshness

Run the queries in `docs/ticket_embedding_queries.sql` against the project database.

## Recommended Resume Order

1. Backfill or refresh summaries first.
2. Index embeddings second.
3. Validate remote coverage and canonical quality third.
4. Only then tune retrieval thresholds if result quality needs adjustment.

## Notes

- The embedding pipeline assumes one summary embedding row per ticket with `source = 'summary'` and `chunk_index = 0`.
- The current semantic search path is intentionally restricted to canonical summaries.
- The safest operational path is to start with dry runs and bounded batches rather than a full-project push.
