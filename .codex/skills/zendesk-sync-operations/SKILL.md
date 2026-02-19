---
name: zendesk-sync-operations
description: Operate, monitor, and recover the Supabase Zendesk sync pipeline for Virtuix support data. Use when sync jobs fail, ticket freshness is stale, cron behavior is uncertain, or manual intervention is needed to restore reliable ticket ingestion.
---

# Zendesk Sync Operations

Use this runbook when data freshness or pipeline reliability is in question.

## System Context

- Function: `supabase/functions/zendesk-sync/index.ts`
- Primary ticket table: `public.zendesk_tickets`
- Run-log table: `public.zendesk_sync_runs`
- UI trigger point: Hub page sync action (`src/pages/Hub.tsx`)

## Incident Workflow

1. Detect scope of failure.
   - Confirm stale data window and impacted surfaces (`/hub`, reports, handoffs).
2. Inspect latest run history.
   - Query recent `public.zendesk_sync_runs` rows for status, timings, and error patterns.
3. Classify failure mode.
   - `Auth/config`: invalid or missing Zendesk/Supabase secrets.
   - `Rate limit/transient`: repeated `429` or `5xx`.
   - `Data/logic`: schema mismatch, parsing issue, or bad incremental cursor behavior.
   - `Scheduler`: cron or trigger execution gaps.
4. Execute targeted recovery.
   - Trigger manual sync only after root-cause hypothesis is defined.
   - Avoid repeated retries without new mitigation.
5. Verify recovery.
   - Ensure new successful run appears.
   - Confirm ticket freshness and expected volume delta in `public.zendesk_tickets`.
6. Publish operator update.
   - State impact window, recovery time, residual risk, and next preventive action.

## SQL Checks

Use this baseline query during triage:

```sql
select started_at, finished_at, status, tickets_fetched, tickets_upserted, error_message
from public.zendesk_sync_runs
order by started_at desc
limit 20;
```

If needed, add checks for stale `updated_at` values in `public.zendesk_tickets`.

## Recovery Rules

- Keep one incident owner per sync event.
- Prefer deterministic fixes over repeated manual sync attempts.
- Escalate to engineering when failure repeats after one validated recovery.
- Capture one preventive action per incident (alerting, retry tuning, validation guardrail).
