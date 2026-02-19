---
name: ux-ui-design
description: Use this skill when improving visual design and UX for this project’s React/Tailwind pages, especially layout hierarchy, branding placement, table usability, and desktop/mobile polish.
---

# UX/UI Design

## Purpose

Apply consistent, production-focused UI/UX improvements to project pages while preserving existing component patterns.  
Use it for page redesigns, layout refinements, branding updates, and better table workflows.

## Workflow

1. Identify page intent and primary action.
2. Preserve existing design system primitives (`Button`, `Input`, spacing scale, typography classes).
3. Establish visual hierarchy:
- top brand row
- page title/context
- core content blocks
4. Improve scanability:
- concise headings
- whitespace separation
- stable table controls (filter/search/sort near table)
5. Validate responsive behavior:
- test at narrow/mobile and wide desktop widths
- avoid horizontal overflow unless table content requires it

## Page Rules

- Keep public page focused on schedule consumption and clear navigation to internal tools.
- Keep `/hub` focused on authenticated operational data, grouped by function.
- Put brand marks in predictable locations (top-left) for fast orientation.
- Prefer concrete labels and avoid placeholder text in final UI labels.

## Table Rules

- Include clear columns tied to operational decisions.
- Keep first load useful with sensible default rows.
- Show empty/loading/error states inline.
- Keep row density readable; avoid tiny text and cramped padding.

## Implementation Notes

- Reuse assets from `src/assets/`.
- Keep edits in page/component files; avoid global CSS churn unless required.
- Run `npm run build` after significant layout changes.
