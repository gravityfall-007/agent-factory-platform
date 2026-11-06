# Agent Factory

Agent Factory is a local model-backed operations console for a firm's digital workforce. An executive agent plans a task, delegates subtasks to branch employees, and synthesizes their results.

## Start locally

Requires Node.js 24 or newer. There is no package install step.

1. Copy `.env.example` to `.env` and set the gateway base URL, model name, and API key.
2. Load those variables and start the server:

   ```sh
   set -a
   . ./.env
   set +a
   node server.mjs
   ```

3. Open <http://127.0.0.1:8000>.

The server binds to loopback by default. It sends model requests from the server to the configured API gateway; the browser calls only same-origin `/api` routes. The API key is never returned to the browser. The gateway must support the OpenAI Responses API. No app-facing Codex proxy endpoint is configured in this workspace; provide your gateway URL and model in the server environment.

## What works

- Create, edit, remove, and persist employee-agent profiles with branch, manager, capabilities, availability, and tool permission labels.
- Submit a task to the executive agent, delegate to up to three employee agents, and view each response plus the executive synthesis.
- Persist workspace changes and task history across server restarts.
- Review and resolve seeded approval examples; decisions are saved to workspace history.
- Export the current employee roster and tool permission labels as CSV.

## Model gateway settings

Replace the placeholder key before starting. Set these values in the server environment (the `.env` file is ignored by git):

- `OPENAI_BASE_URL` — base URL for an OpenAI Responses-compatible gateway, typically ending in `/v1`.
- `OPENAI_API_KEY` — gateway credential. Do not place it in browser code or commit it.
- `AGENT_FACTORY_MODEL` — model identifier accepted by that gateway.

If these settings are missing, the app displays a gateway setup message and does not claim that a task ran. Model requests may incur usage charges according to the gateway's model and billing settings.

## Integrations and security boundary

The tool catalog stores permission labels only. Generic remote MCP servers can be registered under Integrations with an HTTPS URL, description, explicit allowed tool names, and optional bearer token. Grant a subset of those names to each employee; the executive receives no MCP tools by default. Tool names are entered manually; discovery and OAuth are not included. The configured Responses API gateway and model must support remote MCP tools and be able to reach the endpoint.

Every MCP call pauses for a human decision. The approval card displays the server, employee, exact tool name, and arguments. Approving sends those displayed arguments to the remote MCP server and may cause an external action; rejecting resumes the workflow with a rejection. A workflow may pause again for another approval. Do not approve calls unless you intend to share the displayed data with that server.

Bearer tokens are submitted only to the same-origin local server and are never returned to the browser. In this local MVP, they are stored unencrypted with owner-only permissions in ignored `data/connector-secrets.json`; production should use a managed secret store. Connector URLs must be public HTTPS endpoints without embedded credentials, query strings, or fragments. Do not configure a connector unless you trust its operator and endpoint. No live external call occurs until a task uses a granted tool and its exact call is approved.

This is a single local workspace, not a deployed SaaS service: there is no login, remote access, tenant isolation, or billing. Workspace state is written to `data/workspace.json`; do not place secrets or customer-sensitive data in the workspace. The server exposes no authentication and must stay on loopback.

## Project structure

- `index.html`, `styles.css`, `app.js` — browser UI and same-origin API client
- `server.mjs` — local API, model gateway proxy, and workspace persistence
- `seed-data.json` — initial sample workspace
- `.10x/` — product contracts, tickets, and review notes

## References

- [AOS Dashboard](https://github.com/tomtomsatnav/agent-orchestration-standard): reference for operational visibility, agent graph, tool feed, and alerts.
- [OpenAI Responses API](https://platform.openai.com/docs/guides/migrate-to-responses): gateway request format used by default.
- [10x engineering skill](https://github.com/z3z1ma/10x): workflow reference used for shaping and review.
