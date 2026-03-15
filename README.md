# Virtuix Support Schedule

Internal support operations app for Virtuix. The project has two main experiences:

- `/` is a public-facing weekly schedule for Omni One and Omni Arena support coverage.
- `/hub` is the authenticated internal workspace for ticket operations, documents, videos, reporting, and AI-assisted support workflows.

## Current Product Scope

### Public schedule

- Current week and next week coverage pulled from published Google Sheets CSV feeds.
- Daily summary cards for current time, business hours, on-duty coverage, and staffed-day count.
- Responsive weekly schedule views for mobile and desktop.
- Direct path into the internal Support Hub.

### Support Hub

Access is limited to `@virtuix.com` accounts in the app flow.

- Shared workspace shell with desktop sidebar, mobile sheet navigation, and route-aware overview metrics.
- Ticket operations
  - Separate Omni One and Omni Arena queue views backed by `ticket_cache`.
  - Search, status filters, bulk selection, and digest generation from the active queue.
  - Ticket detail drawer with AI summary refresh, copy action, Slack send, and Zendesk link-out.
  - Manual Zendesk sync and backfill controls.
- Digests
  - Review saved digests from the `digests` table.
  - Copy markdown or table output.
  - Send digests to Slack.
- Documents
  - Browse PDF documents from Supabase Storage.
  - Logo-first brand filters and top-level folder scoping.
  - Signed URL preview and download.
  - Semantic search over indexed document chunks.
- Videos
  - Curated support video library from `src/lib/hubVideos.ts`.
  - Mixed YouTube and Dropbox playback/open support.
  - Compact logo-first brand filters and now-playing layout.
- Reports
  - Weekly ticket report view from Supabase RPCs.
  - Monthly / quarterly / yearly received-ticket rollups.
  - Copyable high-impact report summary.
  - Weekly dispatch preview and send workflow for Slack + email.
- Copilot
  - Docked chat experience for queue triage and operational guidance.

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
- OpenAI for ticket summaries, digests, and copilot responses

## Data Sources

- Public schedule and Arena site status: Google Sheets CSV feeds in [src/lib/scheduleData.ts](/home/martin-homelab/project-support/virtuix-support-schedule/src/lib/scheduleData.ts)
- Hub tickets: `ticket_cache`
- Ticket summaries: `ticket_summaries`
- Digests: `digests`
- Sync metadata: `zendesk_sync_runs`
- Support documents: Supabase Storage bucket `support-documents` by default

## Routes

- `/` public support coverage schedule
- `/hub` ticket operations
- `/hub/digests` digest history
- `/hub/documents` support PDF library
- `/hub/videos` support video library
- `/hub/reports` weekly reporting and dispatch tools

## Local Development

### Requirements

- Node.js 18+
- npm
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

`npm run test` currently only exercises the placeholder Vitest example, so automated coverage is minimal.

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

For the CLI sync scripts in `package.json`, provide one of:

```bash
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
SUPABASE_FUNCTION_TOKEN="<jwt-for-function-testing>"
```

## Supabase Functions In This Repo

Current function entrypoints:

- [supabase/functions/sync_zendesk/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/sync_zendesk/index.ts)
- [supabase/functions/zendesk-sync/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/zendesk-sync/index.ts)
- [supabase/functions/summarize_ticket/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/summarize_ticket/index.ts)
- [supabase/functions/create_digest/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/create_digest/index.ts)
- [supabase/functions/send_to_slack/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/send_to_slack/index.ts)
- [supabase/functions/copilot_chat/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/copilot_chat/index.ts)
- [supabase/functions/semantic_search_documents/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/semantic_search_documents/index.ts)
- [supabase/functions/hub_analytics/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/hub_analytics/index.ts)
- [supabase/functions/weekly_ticket_report_dispatch/index.ts](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/functions/weekly_ticket_report_dispatch/index.ts)

Function JWT verification is disabled in [supabase/config.toml](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/config.toml), and auth is handled inside the function code with the shared auth helper.

## Function Secrets

These are the important Supabase function secrets used by the current codebase.

### Shared auth / Supabase access

```bash
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

### Zendesk sync

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
```

Optional prompt overrides:

```bash
SUMMARY_SYSTEM_PROMPT
DIGEST_SYSTEM_PROMPT
```

### Slack / weekly dispatch

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

### Deploy functions

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

## Document Semantic Search Indexing

The document indexer lives at [scripts/index_support_documents.py](/home/martin-homelab/project-support/virtuix-support-schedule/scripts/index_support_documents.py).

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

Required environment for the script:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
```

`VITE_SUPABASE_URL` also works as a fallback for the script.

## Project Structure

- [src/pages/Index.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/pages/Index.tsx) public schedule page
- [src/pages/Hub.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/pages/Hub.tsx) authenticated support workspace
- [src/components/schedule/ScheduleTable.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/components/schedule/ScheduleTable.tsx) weekly schedule display
- [src/components/schedule/ArenaSitesTable.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/components/schedule/ArenaSitesTable.tsx) site coverage status table
- [src/components/hub/VideosPane.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/components/hub/VideosPane.tsx) hub video UI
- [src/components/hub/CopilotChatDock.tsx](/home/martin-homelab/project-support/virtuix-support-schedule/src/components/hub/CopilotChatDock.tsx) docked copilot UI
- [src/lib/scheduleData.ts](/home/martin-homelab/project-support/virtuix-support-schedule/src/lib/scheduleData.ts) public schedule + site data loading
- [src/lib/hubVideos.ts](/home/martin-homelab/project-support/virtuix-support-schedule/src/lib/hubVideos.ts) video library source data
- [supabase/migrations](/home/martin-homelab/project-support/virtuix-support-schedule/supabase/migrations) schema and cron history

## Notes

- The repo still contains both `sync_zendesk` and legacy `zendesk-sync` functions.
- Hub routes are wrapped in a pane error boundary so route-specific render failures surface inline instead of blanking the UI.
- The frontend uses the generated Supabase client in [src/integrations/supabase/client.ts](/home/martin-homelab/project-support/virtuix-support-schedule/src/integrations/supabase/client.ts).
- The Vite server configuration is in [vite.config.ts](/home/martin-homelab/project-support/virtuix-support-schedule/vite.config.ts).
