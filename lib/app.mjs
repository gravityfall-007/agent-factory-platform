/**
 * HTTP application: same-origin JSON API, static UI, run event streams, and
 * multi-workspace routing.
 *
 * The server binds to loopback and has no authentication. Mutating requests
 * therefore require a same-origin browser context and JSON, MCP connector URLs
 * are validated against the public-IP policy, and every external tool call
 * pauses for an explicit human approval.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  HttpError,
  MAX_BODY_BYTES,
  MAX_PROMPT_CHARS,
  boundedString,
  stringArray,
  validateState,
} from "./core.mjs";
import { createGateway, publicGatewayStatus, readGatewayConfig } from "./gateway.mjs";
import { createConnectorValidator } from "./connectors.mjs";
import { createWorkspaceManager } from "./workspaces.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.canceled"]);
const MAX_START_REQUESTS_PER_MINUTE = 8;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

async function serveStatic(pathname, request, response) {
  const item = STATIC_FILES.get(pathname);
  if (!item) throw new HttpError(404, "Not found.");
  const [filename, contentType] = item;
  const content = await readFile(path.join(ROOT, filename));
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": content.byteLength,
    "Cache-Control": "no-cache",
    "Content-Security-Policy": CSP,
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "Unexpected request origin.");
  }
  if (parsed.host !== request.headers.host) throw new HttpError(403, "Cross-origin requests are not allowed.");
}

function assertJsonContentType(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Request body must be JSON.");
  }
}

async function readOptionalJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (!contentLength) return {};
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) return {};
  return readJsonBody(request);
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
  assertJsonContentType(request);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function publicConnector(connector, secrets) {
  return { ...connector, hasBearerToken: Boolean(secrets[connector.id]) };
}

async function publicState(ctx) {
  const state = await ctx.store.getState();
  const secrets = await ctx.store.getSecrets();
  state.connectors = state.connectors.map((item) => publicConnector(item, secrets));
  state.workspace = { id: ctx.id, name: ctx.meta.name, company: ctx.meta.company };
  return state;
}

function sseWrite(response, event) {
  if (response.writableEnded || response.destroyed) return false;
  try {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function createApplication({ env = process.env, fetchImpl, lookup, logger = console } = {}) {
  const config = readGatewayConfig(env);
  const dataDir = path.resolve(ROOT, env.AGENT_FACTORY_DATA_DIR || "data");
  const seedFile = path.resolve(ROOT, env.AGENT_FACTORY_SEED_FILE || "seed-data.json");
  const gateway = createGateway(config, { fetchImpl });
  const connectorValidator = createConnectorValidator({ lookup });
  const manager = createWorkspaceManager({ dataRoot: dataDir, seedFile, gateway, connectorValidator, config, logger });
  const rate = new Map();
  /** @type {Map<import("node:http").ServerResponse, string>} */
  const streams = new Map();
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const host of String(env.AGENT_FACTORY_ALLOWED_HOSTS || "").split(",")) {
    const clean = host.trim().toLowerCase();
    if (clean) allowedHosts.add(clean);
  }

  function assertLoopbackHost(request) {
    const raw = String(request.headers.host || "").toLowerCase();
    const hostname = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!allowedHosts.has(hostname)) {
      throw new HttpError(403, "Agent Factory only accepts loopback host names. Set AGENT_FACTORY_ALLOWED_HOSTS to allow a different host.");
    }
  }

  function consumeRate(key, limit, windowMs = 60_000) {
    const now = Date.now();
    const bucket = rate.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      rate.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  async function resolveContext(request, url) {
    const header = request.headers["x-workspace-id"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const id = String(headerValue || url.searchParams.get("workspace") || manager.defaultId);
    return manager.get(id);
  }

  async function workspaceRoutes(request, response, pathname, method) {
    if (pathname === "/api/workspaces" && method === "GET") {
      return sendJson(response, 200, manager.list());
    }
    if (pathname === "/api/workspaces" && method === "POST") {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be an object.");
      const meta = await manager.create({
        name: body.name,
        company: body.company,
        executiveName: body.executiveName,
        executiveRole: body.executiveRole,
        operatorName: body.operatorName,
        operatorRole: body.operatorRole,
        branches: body.branches,
      });
      const ctx = await manager.get(meta.id);
      return sendJson(response, 201, { workspace: meta, ...manager.list(), state: await publicState(ctx) });
    }
    const workspaceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceMatch && method === "PUT") {
      const id = decodeURIComponent(workspaceMatch[1]);
      const body = await readJsonBody(request);
      const workspace = await manager.update(id, { name: body?.name, company: body?.company });
      return sendJson(response, 200, { workspace, ...manager.list() });
    }
    if (workspaceMatch && method === "DELETE") {
      const id = decodeURIComponent(workspaceMatch[1]);
      closeWorkspaceStreams(id);
      const list = await manager.remove(id);
      return sendJson(response, 200, list);
    }
    return null;
  }

  async function route(request, response) {
    assertLoopbackHost(request);
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;
    const method = request.method || "GET";
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating) assertSameOrigin(request);

    if (pathname === "/api/status" && method === "GET") {
      return sendJson(response, 200, publicGatewayStatus(config));
    }
    if (pathname === "/api/health" && method === "GET") {
      return sendJson(response, 200, { ok: true });
    }
    if (pathname === "/api/workspaces" || pathname.startsWith("/api/workspaces/")) {
      const handled = await workspaceRoutes(request, response, pathname, method);
      if (handled !== null) return handled;
      throw new HttpError(404, "API route not found.");
    }

    if (!pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      return serveStatic(pathname, request, response);
    }

    const ctx = await resolveContext(request, url);
    const store = ctx.store;
    const engine = ctx.engine;

    if (pathname === "/api/state" && method === "GET") {
      return sendJson(response, 200, await publicState(ctx));
    }
    if (pathname === "/api/state" && method === "PUT") {
      const input = await readJsonBody(request);
      await store.updateState((state) => {
        const submittedConnectors = (input.connectors || []).map(({ hasBearerToken, ...item }) => item);
        if (JSON.stringify(submittedConnectors) !== JSON.stringify(state.connectors)) {
          throw new HttpError(400, "Manage connector metadata through the connector routes.");
        }
        const protectedApprovals = (items) =>
          (items || [])
            .filter((item) => item.mcp)
            .map((item) => ({ id: item.id, mcp: item.mcp }))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (JSON.stringify(protectedApprovals(input.approvals)) !== JSON.stringify(protectedApprovals(state.approvals))) {
          throw new HttpError(400, "Pending MCP approvals can only be resolved through the approval route.");
        }
        // Runs and usage are server-owned: a stale browser tab must not erase a
        // run that started after the tab loaded the workspace.
        const merged = validateState({ ...input, tasks: state.tasks, usage: state.usage });
        Object.assign(state, merged);
      });
      return sendJson(response, 200, await publicState(ctx));
    }

    if (pathname === "/api/connectors" && method === "POST") {
      const body = await readJsonBody(request);
      const label = boundedString(body?.label, "label", 80, true);
      const endpoint = await connectorValidator(boundedString(body?.url, "url", 2000, true));
      const description = boundedString(body?.description || "", "description", 500);
      const allowedTools = [...new Set(stringArray(body?.allowedTools || [], "allowedTools", 50, 120))];
      const bearerToken = boundedString(body?.bearerToken || "", "bearerToken", 4096);
      const connector = { id: `conn_${randomUUID().replaceAll("-", "")}`, label, url: endpoint, description, allowedTools, enabled: true };
      await store.updateState((state) => state.connectors.push(connector));
      if (bearerToken) {
        const secrets = await store.getSecrets();
        secrets[connector.id] = bearerToken;
        await store.saveSecrets(secrets);
      }
      return sendJson(response, 201, { connector: publicConnector(connector, await store.getSecrets()) });
    }

    const connectorMatch = pathname.match(/^\/api\/connectors\/([^/]+)$/);
    if (connectorMatch && method === "PUT") {
      const id = decodeURIComponent(connectorMatch[1]);
      const body = await readJsonBody(request);
      const current = await store.getState();
      if (!current.connectors.some((item) => item.id === id)) throw new HttpError(404, "Connector not found.");
      const connector = {
        id,
        label: boundedString(body?.label, "label", 80, true),
        url: await connectorValidator(boundedString(body?.url, "url", 2000, true)),
        description: boundedString(body?.description || "", "description", 500),
        allowedTools: [...new Set(stringArray(body?.allowedTools || [], "allowedTools", 50, 120))],
        enabled: body?.enabled !== false,
      };
      const pending = await store.getPending();
      if (Object.values(pending).some((item) => item.connectorId === id)) {
        throw new HttpError(409, "Resolve pending approvals before changing this connector.");
      }
      await store.updateState((state) => {
        state.connectors = state.connectors.map((item) => (item.id === id ? connector : item));
        for (const agent of state.agents) {
          agent.mcpGrants = agent.mcpGrants.map((grant) =>
            grant.connectorId === id ? { ...grant, tools: grant.tools.filter((tool) => connector.allowedTools.includes(tool)) } : grant,
          );
        }
      });
      const secrets = await store.getSecrets();
      if (body.clearBearerToken === true) delete secrets[id];
      else if (typeof body.bearerToken === "string" && body.bearerToken.trim()) secrets[id] = boundedString(body.bearerToken, "bearerToken", 4096, true);
      await store.saveSecrets(secrets);
      return sendJson(response, 200, { connector: publicConnector(connector, secrets) });
    }
    if (connectorMatch && method === "DELETE") {
      const id = decodeURIComponent(connectorMatch[1]);
      const pending = await store.getPending();
      if (Object.values(pending).some((item) => item.connectorId === id)) {
        throw new HttpError(409, "Resolve pending approvals before removing this connector.");
      }
      const current = await store.getState();
      if (!current.connectors.some((item) => item.id === id)) throw new HttpError(404, "Connector not found.");
      await store.updateState((state) => {
        state.connectors = state.connectors.filter((item) => item.id !== id);
        for (const agent of state.agents) agent.mcpGrants = agent.mcpGrants.filter((grant) => grant.connectorId !== id);
      });
      const secrets = await store.getSecrets();
      delete secrets[id];
      await store.saveSecrets(secrets);
      return sendJson(response, 200, { ok: true });
    }

    const approvalMatch = pathname.match(/^\/api\/mcp\/approvals\/([^/]+)$/);
    if (approvalMatch && method === "POST") {
      const id = decodeURIComponent(approvalMatch[1]);
      const body = await readJsonBody(request);
      if (!body || !["approved", "rejected"].includes(body.decision)) throw new HttpError(400, "decision must be approved or rejected.");
      const result = await engine.resumeApproval(id, body.decision);
      return sendJson(response, 202, result);
    }

    if (pathname === "/api/workflows" && method === "POST") {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be an object.");
      const prompt = boundedString(body.prompt, "prompt", MAX_PROMPT_CHARS, true);
      if (!config.configured) {
        throw new HttpError(503, "Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL, or start with AGENT_FACTORY_DEMO=1.");
      }
      const key = `runs:${ctx.id}:${request.socket.remoteAddress || "local"}`;
      if (!consumeRate(key, MAX_START_REQUESTS_PER_MINUTE)) throw new HttpError(429, "Too many run requests. Wait a minute and try again.");
      const result = await engine.start(prompt);
      return sendJson(response, 202, result);
    }

    if (pathname === "/api/runs/active" && method === "GET") {
      return sendJson(response, 200, { runs: engine.activeRuns() });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === "DELETE") {
      const runId = decodeURIComponent(runMatch[1]);
      if (engine.activeRuns().some((run) => run.runId === runId)) throw new HttpError(409, "Cancel this run before deleting it.");
      const state = await store.getState();
      if (!state.tasks.some((task) => task.id === runId)) throw new HttpError(404, "Run not found.");
      const pending = await store.getPending();
      const removed = Object.entries(pending).filter(([, record]) => record.taskId === runId).map(([id]) => id);
      if (removed.length) {
        await store.updatePending((current) => {
          for (const id of removed) delete current[id];
        });
      }
      await store.updateState((workspace) => {
        workspace.tasks = workspace.tasks.filter((task) => task.id !== runId);
        workspace.approvals = workspace.approvals.filter((item) => item.mcp?.runId !== runId);
      });
      return sendJson(response, 200, { ok: true });
    }

    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const runId = decodeURIComponent(cancelMatch[1]);
      const task = await engine.cancel(runId);
      return sendJson(response, 200, { task });
    }

    const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch && method === "GET") {
      return streamRunEvents(request, response, decodeURIComponent(eventsMatch[1]), ctx);
    }

    if (pathname === "/api/workspace/backup" && method === "GET") {
      const backup = await store.exportBackup();
      backup.workspace = { ...ctx.meta };
      const body = JSON.stringify(backup, null, 2);
      const slug = ctx.meta.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="agent-factory-${slug}-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return response.end(body);
    }
    if (pathname === "/api/workspace/restore" && method === "POST") {
      if (engine.activeRuns().length) throw new HttpError(409, "Cancel active runs before restoring a backup.");
      const body = await readJsonBody(request);
      const candidate = body?.state || body;
      await store.replaceState(candidate);
      await store.saveSecrets({});
      await store.savePending({});
      return sendJson(response, 200, { state: await publicState(ctx) });
    }
    if (pathname === "/api/workspace/reset" && method === "POST") {
      if (engine.activeRuns().length) throw new HttpError(409, "Cancel active runs before resetting the workspace.");
      const body = await readOptionalJsonBody(request);
      if (body?.template === "empty") {
        const current = await store.getState();
        await store.reset({
          ...current,
          agents: [],
          approvals: [],
          activities: [],
          tasks: [],
          connectors: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          executive: { ...current.executive, status: "active" },
        });
      } else {
        const seed = JSON.parse(await readFile(seedFile, "utf8"));
        await store.reset(seed);
      }
      return sendJson(response, 200, { state: await publicState(ctx) });
    }

    throw new HttpError(404, "API route not found.");
  }

  async function streamRunEvents(request, response, runId, ctx) {
    const engine = ctx.engine;
    const run = engine.getRun(runId);
    if (!run) {
      const state = await ctx.store.getState();
      const task = state.tasks.find((item) => item.id === runId);
      if (!task) throw new HttpError(404, "Run not found.");
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      sseWrite(response, { type: "run.snapshot", at: new Date().toISOString(), seq: 0, data: { task } });
      sseWrite(response, { type: "run.ended", at: new Date().toISOString(), seq: 0, data: { runId } });
      response.end();
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 3000\n\n");
    streams.set(response, ctx.id);
    let heartbeat;
    let closed = false;
    let unsubscribe = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      streams.delete(response);
    };
    const closeStream = () => {
      cleanup();
      if (!response.writableEnded) response.end();
    };
    unsubscribe = engine.subscribe(runId, (event) => {
      if (closed) return;
      sseWrite(response, event);
      if (TERMINAL_EVENTS.has(event.type)) {
        sseWrite(response, { type: "run.ended", at: new Date().toISOString(), seq: event.seq, data: { runId } });
        closeStream();
      }
    });
    if (closed) return;
    if (!unsubscribe) {
      closeStream();
      return;
    }
    heartbeat = setInterval(() => {
      if (!closed) {
        try {
          response.write(": ping\n\n");
        } catch {
          cleanup();
        }
      }
    }, 15_000);
    heartbeat.unref?.();
    request.on("close", cleanup);
    response.on("close", cleanup);
  }

  const handler = (request, response) => {
    route(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof HttpError)) {
        logger.error?.(`Request failed (${error?.name || "server error"}).`);
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "The server could not complete that request.";
      sendJson(response, status, { error: message });
    });
  };

  function closeWorkspaceStreams(workspaceId) {
    for (const [response, id] of [...streams]) {
      if (id !== workspaceId) continue;
      try {
        response.end();
      } catch {
        response.destroy();
      }
      streams.delete(response);
    }
  }

  function closeStreams() {
    for (const response of [...streams.keys()]) {
      try {
        response.end();
      } catch {
        response.destroy();
      }
      streams.delete(response);
    }
  }

  return {
    config,
    gateway,
    manager,
    handler,
    closeStreams,
    closeWorkspaceStreams,
  };
}

export async function startApplication({ env = process.env, port = 8000, host = "127.0.0.1", logger = console } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be between 0 and 65535.");
  const app = createApplication({ env, logger });
  await app.manager.init();
  await app.manager.ensureWorkspaceDirectories();
  const server = createServer(app.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    ...app,
    server,
    port: actualPort,
    host,
    async close() {
      app.manager.closeAll();
      app.closeStreams();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
