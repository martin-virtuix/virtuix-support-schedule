# Architecture Docs

This folder captures the current system shape of the Virtuix Support Schedule project and the recommended path to improve it.

Files:
- `dependency-graph.md`: current runtime architecture, data-flow boundaries, and major dependencies.
- `refactor-map.md`: proposed code-organization target and phased refactor plan.

Suggested reading order:
1. Read `dependency-graph.md` to understand the system as it exists now.
2. Read `refactor-map.md` to understand the recommended change path.
3. Update both docs together when implementation work materially changes either the runtime graph or the planned module boundaries.

Use these docs as living references. They should be updated when:
- a new Hub feature is added
- a data source or Edge Function changes
- tables or RPCs are added or removed
- the Hub page is split into new modules
