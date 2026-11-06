# Changelog

## 2.0.0 — operations console update

### Runs

- Async run lifecycle with queued, running, waiting, completed, failed, and canceled states.
- Live server-sent events for planning, each delegation, approvals, synthesis, and completion.
- A live run panel with per-employee progress, elapsed time, tokens, and cancellation.
- Run history with status filters, expandable summaries, assignment results, timelines, re-run, delete, and live reconnect.
- Two concurrent runs per process with a small queue for additional requests.
- Runs interrupted by a server restart are marked failed; waiting approvals are rehydrated and can be resumed.

### Approvals

- MCP approval cards show the server, employee, exact tool name, and arguments.
- Approving resumes the run; rejecting resumes it without contacting the remote server.
- Pending approvals are written atomically and survive restarts.
- Connector edits/removals are blocked while a call is pending.
- Canceling a run clears its pending approvals.

### Usage and metrics

- Provider-reported token usage per run, assignment, and workspace.
- Local token budget with a configurable cap and a warning state at 80%.
- Real metrics replace seeded demo figures: active agents, completed runs, pending approvals, and measured tokens.
- Usage report with per-employee and per-run breakdowns.
- Seeded demo usage figures and “DEMO” labels removed.

### Workspace operations

- Command palette (`Ctrl`/`⌘` + `K`) for navigation, actions, employees, and runs.
- Light and dark themes with a no-flash boot script, persisted per browser.
- Workspace JSON backup/restore (connector secrets excluded) and seed reset.
- Profile menu for usage, backup, restore, theme, help, and reset.
- CSV roster export now includes MCP tool grants.
- Activity filters for runs, approvals, and tool-label changes.

### Server and security

- Modular server (`lib/`) with a testable workflow engine and store.
- Demo model mode (`AGENT_FACTORY_DEMO=1`) with deterministic plans, results, simulated usage, and no network access.
- Same-origin and JSON checks for mutations; loopback Host enforcement; strict CSP and frame denial.
- Public-HTTPS-only MCP connector URLs with private-network blocking.
- Atomic approval writes, bounded run logs, configurable data/seed paths, and a token-budget guard.
- Server-owned runs and usage cannot be overwritten by a stale browser tab.

### Tests and docs

- Node test suite covering validation, gateway adapters, workflow approval/cancel/recovery paths, and the HTTP API.
- `.env.example`, `.gitignore`, package scripts, and a rewritten README.
