---
name: ticket-queue-triage
description: Triage and prioritize Zendesk ticket workload for Virtuix support operations. Use when reviewing Omni One and Omni Arena queues, planning daily execution, preparing shift handoffs, or deciding what to escalate first under constrained support capacity.
---

# Ticket Queue Triage

Use this process to convert raw queue data into a ranked action plan for the current shift.

## Queue Inputs

1. Queue snapshot from Hub tables (`src/pages/Hub.tsx`) by brand and status.
2. Ticket age and requester impact signals (from `public.zendesk_tickets` if queried directly).
3. Current staffing capacity from the schedule and active shift owners.
4. Known incidents or release activity that may inflate ticket volume.

## Triage Workflow

1. Segment by queue first.
   - Keep Omni One and Omni Arena visible as separate streams.
2. Rank by urgency and impact.
   - `P1`: service down, blocked onboarding, or broad customer impact.
   - `P2`: partial degradation or high-value customer blocker.
   - `P3`: routine support request with acceptable wait.
3. Apply age pressure.
   - Escalate any ticket that is aging beyond team targets even if impact is moderate.
4. Assign next actions.
   - `Resolve now`, `Investigate`, `Escalate`, or `Wait for customer`.
5. Load-balance to available operators.
   - Keep each operator focused on one brand whenever possible.

## Shift Handoff Format

Always produce this handoff payload:

1. `Top Priorities (next 4 hours)`: ordered ticket list with reason.
2. `Escalations`: ticket ID, owner, escalation target, deadline.
3. `At-Risk Backlog`: tickets likely to breach expectations soon.
4. `Blocked Items`: dependencies on engineering, vendor, or customer response.

## Operating Rules

- Do not leave P1 tickets unowned.
- Avoid burying urgent items under status-only filters.
- Re-evaluate priorities after each sync refresh or major incident update.
- State confidence and assumptions if queue metadata is incomplete.
