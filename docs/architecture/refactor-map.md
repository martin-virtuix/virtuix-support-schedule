# Refactor Map

This document proposes a safe path to split the current Hub architecture into clearer feature boundaries without changing product scope.

## Goals

- Reduce the size and responsibility of `src/pages/Hub.tsx`
- Separate UI rendering from data orchestration
- Make feature boundaries explicit
- Standardize Edge Function calling and Supabase reads
- Align generated Supabase types with the real schema
- Create smaller testable units without changing user-facing behavior

## Non-Goals

- No visual redesign
- No backend rewrite
- No route changes visible to users
- No switch away from Supabase or Edge Functions

## Guiding Principles

- Preserve product behavior before improving structure.
- Extract boundaries before rewriting logic inside those boundaries.
- Keep browser reads and privileged writes easy to distinguish.
- Prefer feature-local hooks/services over one global utility dump.
- Do not change function names, route paths, or database contracts during the early extraction phases unless required.

## Contracts To Preserve During Early Phases

These should remain stable through Phases 1 to 4:

- routes: `/`, `/hub`, `/hub/digests`, `/hub/documents`, `/hub/videos`, `/hub/reports`
- current active Zendesk ingestion entrypoint: `functions/sync_zendesk`
- current operational ticket store: `ticket_cache`
- current reporting RPC names:
  - `get_weekly_ticket_report`
  - `get_ticket_received_rollup`
  - `get_ticket_data_coverage`
- current semantic search RPC name: `match_support_document_chunks`
- current Support Hub auth rule: authenticated `@virtuix.com` users only
- current user-visible queue behavior: selection can span both ticket tables
- current document behavior: storage listing in browser, semantic retrieval through Edge Function

## Current Problems

### `src/pages/Hub.tsx` is doing too much

It currently mixes:
- auth/session lifecycle
- path-based tab routing
- query state
- Supabase reads
- function invocation fallback logic
- sync and backfill controls
- document preview and storage access
- report refresh and dispatch
- component rendering

### Data access is embedded in view code

Examples:
- direct `supabase.from(...)` reads
- direct `supabase.rpc(...)` calls
- direct `fetch(...)` calls to Edge Functions

This makes changes harder to isolate and reuse.

### Domain concepts are not grouped by feature

Tickets, digests, documents, reports, and analytics all live mostly in one page-level file instead of feature-local modules.

### Schema types and app types have drifted

The generated file `src/integrations/supabase/types.ts` is incomplete for the current project shape, so `src/types/support.ts` fills gaps manually.

## Target Structure

Suggested frontend target:

```text
src/
  features/
    hub/
      auth/
        useHubSession.ts
        hubAuth.ts
      shell/
        HubShell.tsx
        HubHeader.tsx
        HubSideNavigation.tsx
        hubRoutes.ts
      api/
        invokeHubFunction.ts
        hubFunctionErrors.ts
      tickets/
        useTicketQueues.ts
        useTicketSelection.ts
        useTicketSummary.ts
        TicketsPane.tsx
        TicketDrawer.tsx
        ticketMetrics.ts
      digests/
        useDigests.ts
        DigestsPane.tsx
      documents/
        useDocuments.ts
        useSemanticDocumentSearch.ts
        DocumentsPane.tsx
        documentPaths.ts
      reports/
        useWeeklyReport.ts
        useReceivedRollup.ts
        useWeeklyDispatch.ts
        ReportsPane.tsx
        reportMetrics.ts
      videos/
        VideosPane.tsx
      copilot/
        useCopilot.ts
      analytics/
        useHubAnalytics.ts
      types/
        hub.ts
  pages/
    Hub.tsx
```

Suggested backend cleanup target:

```text
supabase/
  functions/
    _shared/
      auth.ts
      openai_chat.ts
      responses.ts
      zendesk.ts
    sync_zendesk/
    summarize_ticket/
    create_digest/
    send_to_slack/
    semantic_search_documents/
    copilot_chat/
    hub_analytics/
    weekly_ticket_report_dispatch/
```

## Proposed Ownership After Refactor

| Module | Responsibility |
| --- | --- |
| `pages/Hub.tsx` | thin route entrypoint only |
| `features/hub/shell/*` | shared layout, view switching, top-level workspace metadata |
| `features/hub/auth/*` | sign-in, sign-out, session bootstrap, allowed-domain rules |
| `features/hub/api/*` | one standard function invocation path and error handling |
| `features/hub/tickets/*` | queue reads, ticket selection, drawer interactions, summary refresh |
| `features/hub/digests/*` | digest list, selection, clipboard, Slack |
| `features/hub/documents/*` | storage listing, preview selection, folder filters, semantic search |
| `features/hub/reports/*` | weekly report RPCs, rollup RPCs, dispatch workflows |
| `features/hub/analytics/*` | event tracking wrapper |

## Target End State For `pages/Hub.tsx`

After the refactor, `src/pages/Hub.tsx` should do only four things:

1. resolve which Hub route/view is active
2. mount the shared Hub shell
3. provide top-level auth/session context
4. hand off rendering to feature-owned panes

It should no longer own:
- direct table reads
- direct RPC calls
- direct Edge Function request details
- feature-local state for tickets, digests, documents, or reports

## Phased Plan

## Phase 1: Create Boundaries Without Behavior Change

Move:
- inline helper types and pure utility functions out of `src/pages/Hub.tsx`
- route metadata, metrics helpers, and formatting helpers into feature-local files

Expected output:
- `src/pages/Hub.tsx` still coordinates everything
- utility noise drops sharply

Exit criteria:
- no UI change
- build remains green
- `Hub.tsx` loses formatting and data-normalization helpers

## Phase 2: Extract Auth and Function Invocation

Create:
- `features/hub/auth/useHubSession.ts`
- `features/hub/api/invokeHubFunction.ts`

Move:
- session bootstrap
- allowed-domain checks
- JWT refresh / fallback logic
- client auth debug logic

Expected output:
- every function call goes through one shared helper
- auth behavior is isolated from feature panes

Exit criteria:
- no function call path remains embedded directly in pane components

## Phase 3: Extract Tickets

Create:
- `features/hub/tickets/useTicketQueues.ts`
- `features/hub/tickets/useTicketSelection.ts`
- `features/hub/tickets/useTicketSummary.ts`
- `features/hub/tickets/TicketsPane.tsx`

Move:
- ticket reads from `ticket_cache`
- summary reads from `ticket_summaries`
- queue metrics
- selection logic
- drawer open/close logic
- summary refresh and Slack actions

Expected output:
- ticket area becomes one feature module
- `Hub.tsx` stops owning ticket implementation detail

Exit criteria:
- ticket queues and drawer can be reasoned about without opening `Hub.tsx`

## Phase 4: Extract Digests, Documents, and Reports

Create:
- `features/hub/digests/useDigests.ts`
- `features/hub/documents/useDocuments.ts`
- `features/hub/reports/useWeeklyReport.ts`
- `features/hub/reports/useWeeklyDispatch.ts`

Move:
- digest reads and selection
- document storage listing and preview
- semantic search request/response state
- report RPC loading
- dispatch preview/send flow

Expected output:
- each Hub route corresponds to an actual feature module

Exit criteria:
- pane state lives with the pane's feature, not globally in `Hub.tsx`

## Phase 5: Align Types With Schema

Actions:
- regenerate `src/integrations/supabase/types.ts`
- compare generated types to `src/types/support.ts`
- keep app-level view models only where they differ from raw DB rows

Expected output:
- less duplicate typing
- less chance of silent schema drift

Exit criteria:
- generated types include current tables and RPCs used by the app

## Phase 6: Remove or Label Legacy Paths

Candidates:
- old `functions/zendesk-sync`
- `zendesk_tickets` references if no longer needed
- unused schedule components or session artifacts if confirmed safe

Expected output:
- one clear active Zendesk ingestion path
- less operator confusion

Exit criteria:
- active and legacy pipelines are clearly separated or legacy is removed

## Pull Request Slicing Strategy

This is the recommended implementation shape for actual repo work:

### PR 1: Shared extraction foundation

Include:
- `features/hub/auth/*`
- `features/hub/api/*`
- pure helpers moved out of `src/pages/Hub.tsx`

Do not include:
- ticket UI changes
- document UI changes
- report UI changes

### PR 2: Tickets

Include:
- ticket queue reads
- selection state
- ticket drawer
- summary refresh and Slack actions

Do not include:
- digest pane
- documents pane

### PR 3: Documents and semantic search

Include:
- storage listing
- preview state
- folder state
- semantic search orchestration

### PR 4: Reports and dispatch

Include:
- weekly report loading
- rollup loading
- dispatch preview/send flow

### PR 5: Digests and copilot cleanup

Include:
- digest list and selection
- digest creation orchestration
- copilot invocation wrapper cleanup if still needed

### PR 6: Type alignment and legacy cleanup

Include:
- regenerated Supabase types
- reduced duplicate local types
- old Zendesk path labeling or removal

## Backend Refinements

These are smaller than the frontend split, but worth tracking.

### Shared helpers worth extracting

- Zendesk retry/request logic is duplicated across multiple functions
- OpenAI response shaping is partly shared, partly duplicated
- JSON response helpers are repeated in every function

Target:
- centralize reusable request utilities in `supabase/functions/_shared/`

### Function boundaries to preserve

- `sync_zendesk`: ingestion and reconciliation only
- `summarize_ticket`: one-ticket summarization only
- `create_digest`: multi-ticket digest generation only
- `semantic_search_documents`: retrieval only
- `copilot_chat`: orchestration and grounded response generation
- `weekly_ticket_report_dispatch`: report packaging and sending

Do not merge these into one large backend function.

## Risks and Controls

| Risk | Why it matters | Control |
| --- | --- | --- |
| Regressing auth/session behavior | Hub access is the main internal gate | extract auth first, add smoke checks after each phase |
| Breaking sync and report coordination | reports depend on sync freshness | do not change `zendesk_sync_runs` contract during frontend extraction |
| Storage preview regressions | document browsing depends on signed URL behavior | keep one manual checklist for preview/download/search |
| Type churn | refactor can create temporary duplicate types | standardize on raw DB types vs view models early |
| Large diff size | `Hub.tsx` touches many features | phase by feature, not by mechanical file count |

## Recommended Order for This Repo

1. Extract auth and shared function invocation
2. Extract tickets
3. Extract documents
4. Extract reports
5. Extract digests
6. Regenerate Supabase types
7. Clean legacy paths

This order reduces risk because tickets, sync status, and auth are the central operating path.

## Manual Verification Checklist

Run this checklist after each feature-phase PR:

- Sign in with a `@virtuix.com` account.
- Verify sign-out returns to the locked Hub state cleanly.
- Open `/hub` and confirm both ticket tables load.
- Open a ticket drawer and confirm existing summary state is shown.
- Refresh a ticket summary and confirm the result updates in place.
- Send a ticket summary to Slack.
- Generate a digest from selected tickets and confirm it appears in `/hub/digests`.
- Copy digest markdown and digest table.
- Open `/hub/documents`, switch brands, switch folders, preview a PDF, and download one.
- Run a semantic search in documents and jump from a result to the correct document.
- Open `/hub/reports`, refresh weekly and M/Q/Y data, generate dispatch preview, and verify preview content renders.
- Trigger a Zendesk sync and confirm the sync status card updates.
- Submit a copilot query and confirm citations render.

## Stop Conditions

Pause the refactor and reassess if any of these happen:

- a phase requires changing backend contracts that were meant to stay stable
- the extracted module still depends on most of `Hub.tsx`, which means the boundary is wrong
- generated Supabase types conflict with current runtime assumptions in a way that is not mechanical
- the diff for a single PR spans multiple feature domains without a clear reason

## What Success Looks Like

When this refactor is complete:
- `src/pages/Hub.tsx` is a thin entrypoint, not a monolith
- each Hub view has a dedicated feature module
- browser-side data access is standardized
- function calls share one invocation/error model
- schema types reflect the real backend
- legacy Zendesk paths no longer compete with the current path

## Immediate Next Refactor Slice

The safest first implementation step is:

1. create `features/hub/auth/useHubSession.ts`
2. create `features/hub/api/invokeHubFunction.ts`
3. move session and Edge Function auth-fallback logic out of `src/pages/Hub.tsx`

That produces structural improvement quickly without changing product behavior.
