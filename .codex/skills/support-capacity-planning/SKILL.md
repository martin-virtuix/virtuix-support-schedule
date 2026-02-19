---
name: support-capacity-planning
description: Plan support staffing and execution for Virtuix Support Schedule. Use when updating weekly coverage, balancing Omni One vs Omni Arena workload, preparing for PTO/holidays, or translating ticket volume trends into shift assignments and risk mitigation actions.
---

# Support Capacity Planning

Use this workflow to produce a realistic weekly plan, not just a staffing list.

## Inputs Checklist

Collect these inputs before assigning people:

1. Latest schedule source and UI behavior (`src/lib/scheduleData.ts`, `src/components/schedule/ScheduleTable.tsx`).
2. Ticket pressure by brand/status from Hub (`src/pages/Hub.tsx`, `public.zendesk_tickets`).
3. Team constraints: PTO, known incidents, onboarding/training load.
4. Near-term risk events: release windows, holidays, partner events, launch milestones.

If one input is missing, state assumptions explicitly and proceed with a provisional plan.

## Weekly Planning Workflow

1. Define demand bands.
   - Estimate expected load separately for Omni One and Omni Arena.
   - Classify each day as low, normal, or peak demand.
2. Build a baseline schedule.
   - Assign primary and backup owner per day.
   - Guarantee each brand has clear ownership during core coverage hours.
3. Run risk checks.
   - Single-point-of-failure shifts.
   - No backup on peak days.
   - Excessive context switching across brands in one shift.
4. Apply mitigations.
   - Add backup rotations.
   - Pre-assign escalation owner for each peak window.
   - Defer non-critical work when coverage is thin.
5. Publish execution notes.
   - Include high-risk days, expected queue hotspots, and handoff expectations.

## Output Format

Return these sections in order:

1. `Coverage Plan`: day-by-day assignment summary.
2. `Risk Register`: top 3-5 risks with owner and mitigation.
3. `Escalation Rules`: who acts first for Omni One, Omni Arena, and sync incidents.
4. `Follow-ups`: concrete tasks with due dates for unresolved staffing gaps.

## Planning Rules

- Optimize for predictable coverage over perfect utilization.
- Keep backup ownership explicit; avoid implicit assumptions.
- Prefer fewer handoffs during peak windows.
- Flag any plan that depends on one person for both brands on peak days.
