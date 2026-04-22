# Virtuix Support Schedule

Internal support operations app for Virtuix. The project has two main experiences:

- `/` is a public-facing support coverage calendar.
- `/hub` is the authenticated internal workspace for ticket operations, digests, documents, videos, reports, and AI-assisted support workflows.

## Current Product Scope

### Public schedule

- Current week and next week coverage pulled from published Google Sheets CSV feeds.
- Overview cards for current time, business hours, on-duty coverage, and staffed-day count.
- Responsive weekly schedule views for desktop and mobile.
- Public Omni Arena site table locked to venues currently marked `No Support`.
- Direct path into the internal Support Hub.

### Support Hub

Access is limited to `@virtuix.com` accounts in the app flow.

- Tickets
  - Separate Omni One and Omni Arena queue views backed by `ticket_cache`.
  - Cached keyword search through `search_ticket_cache`.
  - Bulk selection, digest generation, ticket drawer, summary refresh, copy actions, Slack send, and Zendesk link-out.
  - Manual Zendesk sync and live sync-status visibility.
- Digests
  - Review saved digests from `digests`.
  - Copy markdown or table output.
  - Send digests to Slack.
- Documents
  - Browse PDF documents from Supabase Storage.
  - Brand filters and top-level folder scoping.
  - Signed URL preview and download.
  - Semantic search over indexed document chunks.
- Videos
  - Curated support video library from `src/lib/hubVideos.ts`.
  - Mixed YouTube and Dropbox playback/open support.
- Reports
  - Weekly ticket report view from Supabase RPCs.
  - Monthly, quarterly, and yearly received-ticket rollups.
  - Venue SQL import builder for HeidiSQL exports.
  - Weekly dispatch preview and send workflow for Slack and email.
- Copilot
  - Floating multi-session chat dock.
  - Returns structured citations grounded in support documents and ticket history.
  - Ticket-history citations use lexical cache matches plus semantic ticket-summary retrieval from `ticket_embedding_chunks`.

## Stack

- React 18
- TypeScript
- Vite 5
- Tailwind CSS + shadcn/ui + Radix UI
- Supabase
  - Auth
  - Postgres
  - Storage
  - Edge Functions
- OpenAI for ticket summaries, digests, document embeddings, ticket embeddings, and Copilot responses

## Data Sources

- Public schedule and Arena site status: Google Sheets CSV feeds in `src/lib/scheduleData.ts`
- Hub tickets: `ticket_cache`
- Ticket summaries: `ticket_summaries`
- Ticket summary embeddings: `ticket_embedding_chunks`
- Digests: `digests`
- Sync metadata: `zendesk_sync_runs`
- Support document metadata and chunks: `support_document_files`, `support_document_chunks`
- Hub analytics events: `hub_analytics_events`
- Support documents storage bucket: `support-documents` by default

## Routes

- `/` public support coverage calendar
- `/hub` ticket operations
- `/hub/digests` digest history
- `/hub/documents` support PDF library
- `/hub/videos` support video library
- `/hub/reports` weekly reporting and dispatch tools

## Local Development

### Requirements

- Node.js 18+
- npm
- Python 3 for the indexing/backfill scripts
- Supabase CLI for migrations and function deployment

### Install

```bash
npm install
```

### Run the app

```bash
npm run dev
```

Vite is configured for `http://127.0.0.1:8080`.

### Useful scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
npm run test
npm run sync:zendesk
npm run sync:zendesk:omni-one
npm run sync:zendesk:omni-arena
```

`npm run test` currently only exercises minimal Vitest coverage, so automated frontend coverage is still light.

## Frontend Environment

Set these in `.env` for the Vite app:

```bash
VITE_SUPABASE_URL="https://ddqacivmenvlidzxxhyv.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<supabase-anon-key>"
```

Optional:

```bash
VITE_SUPPORT_DOCUMENTS_BUCKET="support-documents"
```

For the CLI Zendesk sync scripts in `package.json`, provide:

```bash
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

Optional override for function invocation:

```bash
SUPABASE_FUNCTION_TOKEN="<jwt-for-function-testing>"
```

## Operator and Script Environment

Ticket-summary backfill uses:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Additional backfill auth options:

```bash
SUPABASE_FUNCTION_TOKEN
SUPABASE_USER_ACCESS_TOKEN
VITE_SUPABASE_PUBLISHABLE_KEY
```

Ticket embedding indexing also requires:

```bash
OPENAI_API_KEY
```

`VITE_SUPABASE_URL` also works as a fallback for the Python scripts when `SUPABASE_URL` is not set.

## Supabase Functions In This Repo

Current function entrypoints:

- `supabase/functions/sync_zendesk/index.ts`
- `supabase/functions/zendesk-sync/index.ts` (legacy function retained in repo)
- `supabase/functions/summarize_ticket/index.ts`
- `supabase/functions/create_digest/index.ts`
- `supabase/functions/send_to_slack/index.ts`
- `supabase/functions/copilot_chat/index.ts`
- `supabase/functions/semantic_search_documents/index.ts`
- `supabase/functions/hub_analytics/index.ts`
- `supabase/functions/weekly_ticket_report_dispatch/index.ts`

Function gateway JWT verification is disabled in `supabase/config.toml`, and auth is enforced inside the function code through the shared auth helper.

## Function Secrets

### Shared auth and Supabase access

```bash
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

### Zendesk sync and enrichment

```bash
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_OMNI_ARENA_BRAND_ID
ZENDESK_OMNI_ONE_BRAND_ID
```

### OpenAI-backed workflows

```bash
OPENAI_API_KEY
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MODEL_FALLBACKS=gpt-4o-mini,gpt-4.1,gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Optional prompt overrides:

```bash
SUMMARY_SYSTEM_PROMPT
DIGEST_SYSTEM_PROMPT
```

### Slack and weekly dispatch

```bash
SLACK_WEBHOOK_URL
RESEND_API_KEY
REPORT_EMAIL_FROM
REPORT_EMAIL_TO
REPORT_EMAIL_CC
REPORT_EMAIL_BCC
```

## Common Supabase Workflow

### Push schema changes

```bash
npx supabase db push
```

### Deploy active functions

```bash
npx supabase functions deploy sync_zendesk
npx supabase functions deploy summarize_ticket
npx supabase functions deploy create_digest
npx supabase functions deploy send_to_slack
npx supabase functions deploy copilot_chat
npx supabase functions deploy semantic_search_documents
npx supabase functions deploy hub_analytics
npx supabase functions deploy weekly_ticket_report_dispatch
```

Deploy `zendesk-sync` only if you still need the legacy function path.

## Document Semantic Search Indexing

The document indexer lives at `scripts/index_support_documents.py`.

It targets:

- `support-documents/omni_one/knowledge_base/**`
- `support-documents/omni_arena/knowledge_base/**`

Python requirements:

```bash
python3 -m pip install requests pypdf
```

Run it with:

```bash
python3 scripts/index_support_documents.py
```

Required environment:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
```

## Ticket Summary Backfill and Semantic Search Indexing

The ticket semantic-search pipeline is split into two operator scripts:

- `scripts/backfill_ticket_summaries.py`
  - refreshes ticket summaries through the deployed `summarize_ticket` function
  - classifies tickets as missing, legacy, noncanonical, or stale
  - normalizes summaries into the canonical retrieval format:
    - `Issue:`
    - `Troubleshooting:`
    - `Resolution:`
- `scripts/index_ticket_summaries.py`
  - indexes only canonical summaries into `ticket_embedding_chunks`
  - can purge existing embedding rows for legacy or noncanonical summaries
  - batches embeddings through the OpenAI embeddings API

Python requirements:

```bash
python3 -m pip install requests
```

Safe resume workflow:

```bash
python3 scripts/backfill_ticket_summaries.py --dry-run --include-stale --order desc
python3 scripts/index_ticket_summaries.py --dry-run --purge-noncanonical-existing --order desc
```

Bounded live runs:

```bash
python3 scripts/backfill_ticket_summaries.py --include-stale --order desc --max-tickets 100
python3 scripts/index_ticket_summaries.py --purge-noncanonical-existing --order desc --max-tickets 100
```

Useful targeting flags:

- `--ticket-id`
- `--ticket-id-min`
- `--ticket-id-max`
- `--brand`
- `--force`

Validation SQL lives in `docs/ticket_embedding_queries.sql`.

The semantic-search schema and RPCs live in:

- `supabase/migrations/20260416190000_add_ticket_summary_semantic_search.sql`
- `supabase/migrations/20260416201500_filter_ticket_semantic_search_to_canonical_summaries.sql`

## Project Structure

- `src/pages/Index.tsx` public schedule page
- `src/pages/Hub.tsx` authenticated support workspace
- `src/components/hub/CopilotChatDock.tsx` floating Copilot chat UI
- `src/components/hub/VideosPane.tsx` video library UI
- `src/lib/scheduleData.ts` public schedule and Arena site data loading
- `src/lib/hubVideos.ts` curated video library source data
- `scripts/index_support_documents.py` document chunk and embedding indexer
- `scripts/backfill_ticket_summaries.py` ticket summary backfill runner
- `scripts/index_ticket_summaries.py` ticket summary embedding indexer
- `docs/ticket_embedding_queries.sql` ticket embedding validation queries
- `supabase/migrations` schema and cron history

## Notes

- The repo still contains both `sync_zendesk` and legacy `zendesk-sync`.
- Hub routes are wrapped in a pane error boundary so route-specific render failures surface inline instead of blanking the workspace.
- The frontend uses the generated Supabase client in `src/integrations/supabase/client.ts`.
- The Vite server configuration is in `vite.config.ts`.
