# MCP TypeScript SDK v1 over v2

The MCP TypeScript SDK split in July 2026: `@modelcontextprotocol/sdk` (now 1.32.2, maintenance-mode) and `@modelcontextprotocol/server` (2.4.0, current stable). CoastWise targets **v1** with `zod` ^4, using the non-deprecated `registerTool` API.

The brief said "the current official MCP TypeScript SDK" — we chose the better-documented package instead, on the explicit instruction that documentation density and a hours-not-days schedule outrank recency.

## Considered Options

- **v2** — matches the brief literally, and ships `outputSchema` → `structuredContent` for typed tool responses. Rejected: three months old, sparse references, and a far higher chance of burning schedule on unfamiliar API edges.
- **v1** — `.tool()` is deprecated but `registerTool` exists and is current within v1, so we lose nothing by pinning the package.

## Consequences

- **A future reader will see `@modelcontextprotocol/sdk` and assume we missed the migration.** This ADR is why we did not. Do not "fix" it without re-running the cost/benefit against the schedule.
- v1 is bugfix/security-only for six months from 2026-07-27; the pin is deliberately time-bounded.
- Tool responses are emitted as `content: [{ type: 'text', text: JSON.stringify(...) }]` rather than `structuredContent`, for broad client compatibility.
- engines: `node >= 18` (dev environment is Node 24).
