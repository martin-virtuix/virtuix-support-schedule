# Virtuix Support Schedule + Support Hub

A Vite/React app with two experiences:

- Public schedule page (`/`) for weekly Omni support coverage.
- Private Support Hub (`/hub`) for Virtuix employees, including Zendesk ticket operations and Arena sites data.

## Current Scope

### Public (`/`)
- Displays current and next week support schedules.
- Uses Google Sheets CSV as source of truth.
- Includes login CTA to the private Hub.

### Private Hub (`/hub`)
- Supabase Auth sign-in flow (email OTP), restricted to `@virtuix.com` users in app logic and DB RLS read policies.
- Two Zendesk-backed ticket tables:
  - Omni One tickets
  - Omni Arena tickets
- Features:
  - Status filters (`all`, `open`, `pending`, `new`)
  - Status badge colors (Zendesk-like)
  - Requester column
  - Ticket links to Zendesk agent view
  - Scrollable tables with sticky headers
- Arena Sites table with filters/search/sort and sticky-header scrolling.
- `Sync now` button triggers Zendesk sync function and refreshes Hub data.

## Tech Stack

- React 18 + TypeScript
- Vite 5
- Tailwind CSS + shadcn/Radix UI
- Supabase (Postgres, Auth, Edge Functions)

## Data Sources

- Schedule and sites CSVs: Google Sheets published CSV URLs (see `src/lib/scheduleData.ts`).
- Hub tickets: `public.zendesk_tickets` (synced from Zendesk API via edge function).

## Zendesk Sync Pipeline

### Function
- Edge function: `supabase/functions/zendesk-sync/index.ts`
- Pulls Zendesk incremental tickets API.
- Upserts into `public.zendesk_tickets`.
- Writes run metadata/errors to `public.zendesk_sync_runs`.

### Scheduling
- Automatic cron job every 5 minutes (DB migration-managed).
- Manual sync available via Hub `Sync now` button.

### Reliability
- Retry/backoff on Zendesk `429` and `5xx`.
- Overlap protection:
  - DB constraint allows only one `running` sync at a time.
  - Function returns `202 skipped` if a run is already in progress.

## Supabase Project

Configured project ref:

- `ddqacivmenvlidzxxhyv` (see `supabase/config.toml`)

## Required Environment Variables

### Frontend (`.env`)

```bash
VITE_SUPABASE_PROJECT_ID="ddqacivmenvlidzxxhyv"
VITE_SUPABASE_URL="https://ddqacivmenvlidzxxhyv.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<supabase-anon-key>"
```

Optional (only for Zendesk link fallback in UI):

```bash
VITE_ZENDESK_SUBDOMAIN="<your-subdomain>"
```

### Supabase Edge Function Secrets

Set in Supabase (not in `.env`):

```bash
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_OMNI_ARENA_BRAND_ID=360007126832
ZENDESK_OMNI_ONE_BRAND_ID=26871345286541
```

## Local Development

### Prerequisites
- Node.js 18+
- npm
- Supabase CLI (for migrations/functions workflow)

### Install + Run

```bash
npm install
npm run dev
```

By default this project is configured to run Vite on:

- `http://127.0.0.1:8080`

If port `8080` is in use, Vite auto-selects the next available port.

## Scripts

```bash
npm run dev        # Start dev server
npm run build      # Production build
npm run test       # Run tests
npm run lint       # Lint code
npm run preview    # Preview built app
```

## Supabase Workflow

### Apply migrations

```bash
npx supabase db push
```

### Deploy function

```bash
npx supabase functions deploy zendesk-sync
```

### New Edge Functions (Copilot + Digest)

Deploy the new functions:

```bash
npx supabase functions deploy sync_zendesk
npx supabase functions deploy summarize_ticket
npx supabase functions deploy create_digest
npx supabase functions deploy send_to_slack
```

Required function secrets:

```bash
# Zendesk sync
ZENDESK_SUBDOMAIN
ZENDESK_EMAIL
ZENDESK_API_TOKEN
ZENDESK_OMNI_ARENA_BRAND_ID
ZENDESK_OMNI_ONE_BRAND_ID

# AI ticket summarization
OPENAI_API_KEY
OPENAI_MODEL=gpt-4o-mini

# Slack delivery
SLACK_WEBHOOK_URL
```

Set or update secrets:

```bash
npx supabase secrets set \
  ZENDESK_SUBDOMAIN="<subdomain>" \
  ZENDESK_EMAIL="<email>" \
  ZENDESK_API_TOKEN="<token>" \
  ZENDESK_OMNI_ARENA_BRAND_ID="360007126832" \
  ZENDESK_OMNI_ONE_BRAND_ID="26871345286541" \
  OPENAI_API_KEY="<openai-key>" \
  OPENAI_MODEL="gpt-4o-mini" \
  SLACK_WEBHOOK_URL="<slack-incoming-webhook-url>"
```

Apply schema updates for copilot/digest tables:

```bash
npx supabase db push
```

## Routing

- `/` → public schedule page
- `/hub` → private support hub (auth required)

## Project Structure (key files)

- `src/pages/Index.tsx` — public schedule UI
- `src/pages/Hub.tsx` — private Hub UI + sync action
- `src/components/schedule/ScheduleTable.tsx` — schedule table
- `src/components/schedule/ArenaSitesTable.tsx` — Arena sites table
- `src/lib/scheduleData.ts` — CSV parsing/loading
- `src/integrations/supabase/client.ts` — frontend Supabase client
- `supabase/migrations/*` — DB schema, RLS, cron, protections
- `supabase/functions/zendesk-sync/index.ts` — Zendesk ingest function

## Troubleshooting

### `npm run dev` fails with `EPERM ... 8080`
- Usually environment permission/port issue.
- Ensure no conflicting process is bound to `8080`, or let Vite use next port.

### `Failed to resolve import "papaparse"`
- Run `npm install` in repo root.

### Sync error in Hub
- Check latest run logs:

```sql
select started_at, finished_at, status, tickets_fetched, tickets_upserted, error_message
from public.zendesk_sync_runs
order by started_at desc
limit 20;
```
