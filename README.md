# Agent Factory

Agent Factory is a local operations console for one or more company workspaces with a model-backed digital workforce. Each company gets its own executive agent, employees, branches, tool catalog, approvals, run history, usage, and connector tokens. An executive agent plans a task, delegates work to branch employees, pauses on external tool calls for a human decision, and synthesizes the results.

The console is designed for one operator on one machine. It has no login, tenant isolation, or billing, and it binds to loopback by default.

## Highlights

- **Live runs** — planning, each assignment, approvals, synthesis, and completion stream into the UI over SSE. Runs can be canceled, queued, and re-run.
- **Human approval for tools** — a granted remote MCP tool call pauses the run. The approval card shows the server, employee, exact tool name, and arguments. Approving sends those arguments to the remote server; rejecting resumes the run without contacting it.
- **Run history** — every run persists its plan, assignment results, per-run usage, status, and a bounded event timeline. Filter by status, expand a run, or download/restore the workspace.
- **Measured usage** — provider-reported tokens per run and assignment, a configurable local budget, and a usage report by employee and run.
- **Demo mode** — run the entire product without a gateway key. Every model and tool call is simulated, deterministic, clearly labeled, and makes no network requests.
- **Company workspaces** — create a clean workspace for another company, switch between them, rename the company/workspace, manage branches and the operator profile, and delete a workspace without touching the others.
- **Editable everywhere** — employee roles, managers, capabilities, availability, tool labels, MCP grants, executive profile, tool catalog entries, branch lists, company names, and operator profile all have working edit flows.
- **Operator conveniences** — command palette (`Ctrl`/`⌘ + K`), light/dark themes, CSV roster export, JSON backup/restore, and a reset that can clear a workspace while keeping its company identity.
- **Hardened local API** — loopback Host enforcement, same-origin + JSON mutation checks, strict CSP, atomic persistence, connector URL policy, and bounded inputs.

## Quick start

Requires Node.js 24 or newer. There are no runtime dependencies or install steps.

### 1. Try demo mode

```sh
AGENT_FACTORY_DEMO=1 node server.mjs
```

Open <http://127.0.0.1:8000>. Demo mode simulates the model gateway, external tool calls, and usage. It never contacts a model or MCP server. Use a prompt containing `[mcp]` to make the demo request an MCP approval, provided an employee has a grant.

### 2. Run a live gateway

```sh
cp .env.example .env
# Edit .env: set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL.
set -a
. ./.env
set +a
node server.mjs
```

The gateway must accept the OpenAI **Responses API** format. The server sends model requests from the server process to that gateway; the browser only calls same-origin `/api` routes, and the API key is never returned to the browser.

Demo mode takes precedence over live mode when both are configured.

## Company workspaces

The switcher at the top of the sidebar lists every company workspace and opens the create/settings flows.

- **Create** — choose a company name, workspace label, executive name/role, operator name, and branches. The new workspace starts empty with the shared tool catalog and no employees, approvals, runs, or tokens.
- **Switch** — each workspace has isolated employees, tools, branches, runs, approvals, usage, and connector tokens. Switching does not stop runs; they continue on the server and can be reopened from run history or the live panel when you switch back.
- **Settings** — rename the company/workspace, edit the operator profile, add or remove branches (blocked while an employee is assigned to the branch), or delete the workspace. At least one workspace must remain.
- **Editable executive/tools** — edit the executive from the pencil button on its card; edit or delete tool labels from the catalog. Renaming a tool label updates every employee and executive reference.

Workspace-scoped requests carry an `X-Workspace-Id` header. SSE URLs use `?workspace=<id>` because `EventSource` cannot set custom headers. The active workspace is remembered per browser.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Responses-compatible gateway base URL. HTTPS, or HTTP only for loopback. |
| `OPENAI_API_KEY` | — | Gateway credential. Required for live mode. |
| `AGENT_FACTORY_MODEL` | `gpt-4.1-mini` | Model identifier sent to the gateway. |
| `AGENT_FACTORY_DEMO` | off | `1`/`true` enables the deterministic simulated gateway. |
| `AGENT_FACTORY_TOKEN_BUDGET` | `100000` | Local guard rail. New runs are refused once cumulative usage reaches it. |
| `AGENT_FACTORY_TIMEOUT_MS` | `90000` | Per-request gateway timeout. |
| `AGENT_FACTORY_DATA_DIR` | `./data` | Workspace, secrets, and pending-approval directory. |
| `AGENT_FACTORY_SEED_FILE` | `./seed-data.json` | Seed used for a new workspace or a reset. |
| `AGENT_FACTORY_ALLOWED_HOSTS` | — | Comma-separated extra hostnames accepted in the `Host` header. Loopback is always allowed. |
| `PORT` | `8000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Do not expose the unauthenticated server to a network. |

The token budget is a local safety guard, not a billing statement. Usage comes from gateway metadata when present; requests without usage metadata count as zero. In demo mode, usage is simulated.

## How a run works

1. `POST /api/workflows` validates the prompt, checks the gateway and budget, creates a queued task, and returns `202` with a run ID.
2. The executive agent receives the active roster and returns a JSON delegation plan (at most three employees).
3. Each employee returns a result. If the model asks to use a granted MCP tool, the run persists a pending approval, pauses, and emits `approval.required`.
4. A decision at `/api/mcp/approvals/:id` resumes the run. Approving forwards the displayed arguments; rejecting does not contact the remote server. More calls can pause the run again.
5. The executive synthesizes the completed employee results. Usage and the final summary are persisted.

`GET /api/runs/:id/events` streams named SSE events. A run that finished while the server was down is replayed from persisted state as a snapshot. Waiting approvals are rehydrated on startup and can still be resumed.

## API surface

All routes are same-origin and return JSON unless noted.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Gateway mode, model, format, and budget. |
| `GET` | `/api/workspaces` | List company workspaces and the default ID. |
| `POST` | `/api/workspaces` | Create a company workspace. |
| `PUT` | `/api/workspaces/:id` | Rename a workspace/company. |
| `DELETE` | `/api/workspaces/:id` | Delete a workspace with no active runs (last one is protected). |
| `GET` | `/api/state` | Full workspace state plus connector token presence flags and workspace metadata. |
| `PUT` | `/api/state` | Save roster/tools/activities. Server-owned runs, usage, and MCP approvals are preserved. |
| `POST` | `/api/workflows` | Start a run (`202`). |
| `GET` | `/api/runs/active` | Queued, running, and waiting runs. |
| `GET` | `/api/runs/:id/events` | SSE stream (`text/event-stream`). |
| `POST` | `/api/runs/:id/cancel` | Cancel and clean up pending approvals. |
| `DELETE` | `/api/runs/:id` | Delete a finished run. |
| `POST` | `/api/mcp/approvals/:id` | `{ "decision": "approved" \| "rejected" }`. |
| `GET/POST/PUT/DELETE` | `/api/connectors…` | MCP connector metadata and bearer-token storage. |
| `GET` | `/api/workspace/backup` | Download the workspace (no connector tokens). |
| `POST` | `/api/workspace/restore` | Restore `{ "state": … }` with no active runs. |
| `POST` | `/api/workspace/reset` | Clear workspace data, or restore the seed with `{ "template": "seed" }`; no active runs. |
| `GET` | `/api/health` | Liveness check. |

Workspace-scoped API routes accept `X-Workspace-Id`; requests without it use the default workspace. Mutating requests require `Content-Type: application/json` and a same-origin browser context. Requests addressed to a non-loopback `Host` are rejected unless it is listed in `AGENT_FACTORY_ALLOWED_HOSTS`.

## Security and privacy boundary

- **No authentication.** Keep the server on loopback. Anyone who can reach the port can act as the workspace admin.
- **Tool approvals are mandatory.** Every remote MCP call pauses for an explicit decision that displays the exact arguments. Approval may cause an external action.
- **Connector URLs must be public HTTPS.** Embedded credentials, query strings, fragments, localhost, private networks, and cloud metadata addresses are rejected. The model gateway must be able to reach the endpoint.
- **Tokens are local, not encrypted.** Bearer tokens are stored with owner-only permissions in ignored `data/connector-secrets.json`. Production should use a managed secret store.
- **Workspace data is plaintext.** Each `data/workspaces/<id>/workspace.json` contains prompts, results, and activity. Do not put customer secrets in it. Backups exclude connector tokens, but include all workspace content. Company workspaces are isolated data folders, not authenticated tenants.
- **Prompt injection is not solved.** Model output is displayed as text, never executed, but an agent can still be persuaded to request a tool call. Read approval arguments before approving.
- **Demo mode is simulated.** Demo results, tool outcomes, and usage are labeled as simulated and never claim an external action occurred.

## Development

```sh
npm test              # node --test: validation, gateway, workflow, API
node --watch server.mjs
```

The suite uses temporary data directories, a deterministic demo gateway, and fake gateways. No network access or API key is required.

### Project structure

- `server.mjs` — process entry point and graceful shutdown.
- `lib/app.mjs` — HTTP routing, SSE streams, static files, origin/host checks.
- `lib/workflow.mjs` — run lifecycle, delegation, approvals, cancellation, recovery.
- `lib/workspaces.mjs` — company workspace registry, migration, isolation, create/rename/delete.
- `lib/gateway.mjs` — live Responses client, demo gateway, usage extraction.
- `lib/store.mjs` — atomic workspace, secret, and pending-approval persistence.
- `lib/core.mjs` — limits, errors, and workspace validation.
- `lib/connectors.mjs` — public-HTTPS connector URL policy.
- `index.html`, `styles.css`, `app.js`, `theme.js` — browser UI and same-origin client.
- `seed-data.json` — initial/default workspace seed and new-workspace tool/executive template.
- `test/` — Node test suite.

### Data files

| File | Contents | Permissions |
| --- | --- | --- |
| `data/workspaces.json` | Company workspace registry and default workspace | `0600` |
| `data/workspaces/<id>/workspace.json` | Executive, employees, branches, operator, tools, connectors, approvals, activity, runs, usage | `0600` |
| `data/workspaces/<id>/connector-secrets.json` | Connector bearer tokens for that workspace | `0600` |
| `data/workspaces/<id>/pending-approvals.json` | Resumable model approval state for that workspace | `0600` |

A legacy single-workspace `data/workspace.json` is copied into the default `northstar` workspace on first start and left in place for reference; it is not modified after migration.

Use the profile menu or the API to download a workspace backup. Restoring a backup clears connector tokens and pending approvals; re-enter tokens afterward.

## Known limitations

- One process and one operator. Company workspaces are isolated data, not authenticated tenants; anyone who can reach the port can switch or edit any workspace. No roles or user accounts.
- Remote MCP calls depend on the gateway's Responses API MCP support and on the model choosing a granted tool.
- Approval state is tied to the gateway's stored response; a provider-side expiry can require a new run.
- Runs interrupted by a restart are marked failed. Completed totals remain, but mid-run tokens are not recovered.
- The run queue holds three runs behind two active slots; the token budget is checked when a run starts, not continuously enforced.

## References

- [OpenAI Responses API](https://platform.openai.com/docs/guides/migrate-to-responses)
- [AOS Dashboard](https://github.com/tomtomsatnav/agent-orchestration-standard) — reference for operational visibility and the agent graph.
- [10x engineering skill](https://github.com/z3z1ma/10x) — workflow reference used for shaping and review.
