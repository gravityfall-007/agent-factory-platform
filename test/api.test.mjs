import test from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { startApplication } from "../lib/app.mjs";
import { baseSeed, makeTestStore, waitFor } from "./helpers.mjs";

async function boot(seed = baseSeed()) {
  const fixture = await makeTestStore(seed);
  const app = await startApplication({
    env: {
      AGENT_FACTORY_DEMO: "1",
      AGENT_FACTORY_DATA_DIR: fixture.dataDir,
      AGENT_FACTORY_SEED_FILE: fixture.seedFile,
    },
    port: 0,
    host: "127.0.0.1",
  });
  const base = `http://127.0.0.1:${app.port}`;
  return {
    app,
    base,
    fixture,
    async close() {
      await app.close();
      await fixture.cleanup();
    },
    async json(path, options) {
      const response = await fetch(`${base}${path}`, options);
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    },
    async state() {
      return (await this.json("/api/state")).payload;
    },
  };
}

async function startRun(ctx, prompt) {
  const { response, payload } = await ctx.json("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  assert.equal(response.status, 202);
  assert.ok(payload.runId);
  return payload.runId;
}

async function waitForStatus(ctx, runId, statuses, timeout = 5000) {
  return waitFor(
    async () => {
      const state = await ctx.state();
      const task = state.tasks.find((item) => item.id === runId);
      return task && statuses.includes(task.status) ? { task, state } : null;
    },
    { timeout, label: `run status ${statuses.join("/")}` },
  );
}

async function readRunEvents(base, runId) {
  const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6));
      events.push(event);
      if (event.type === "run.ended") {
        await reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  return events;
}

test("API serves status, state, static files, and security headers", async () => {
  const ctx = await boot();
  try {
    const status = await ctx.json("/api/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.mode, "demo");
    assert.equal(status.payload.configured, true);
    assert.equal(status.payload.budget, 100000);

    const health = await ctx.json("/api/health");
    assert.deepEqual(health.payload, { ok: true });

    const state = await ctx.state();
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.agents.length, 2);
    assert.equal(state.usage.totalTokens, 0);

    const index = await fetch(`${ctx.base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Agent Factory/);
    assert.match(html, /Command palette|palette-dialog/);
    const csp = index.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.equal(index.headers.get("x-frame-options"), "DENY");

    const theme = await fetch(`${ctx.base}/theme.js`);
    assert.equal(theme.status, 200);
    assert.match(theme.headers.get("content-type"), /javascript/);

    const missing = await ctx.json("/api/missing");
    assert.equal(missing.response.status, 404);
    assert.match(missing.payload.error, /not found/i);
  } finally {
    await ctx.close();
  }
});

test("a workflow streams live events and persists a completed run", async () => {
  const ctx = await boot();
  try {
    const runId = await startRun(ctx, "Prepare a renewal plan for Acme Studio");
    const events = await readRunEvents(ctx.base, runId);
    const types = events.map((event) => event.type);
    for (const expected of ["run.started", "plan", "assignment.started", "assignment.completed", "run.synthesizing", "run.completed", "run.ended"]) {
      assert.ok(types.includes(expected), `expected ${expected}, got ${types.join(", ")}`);
    }
    const { task, state } = await waitForStatus(ctx, runId, ["done"]);
    assert.ok(task.summary.length > 0);
    assert.equal(task.assignments.length, 2);
    assert.ok(task.usage.totalTokens > 0);
    assert.ok(state.usage.totalTokens > 0);
    assert.equal(state.usage.totalTokens, task.usage.totalTokens);
    assert.equal(state.activities[0].kind, "complete");
    const plan = events.find((event) => event.type === "plan");
    assert.equal(plan.data.assignments.length, 2);
    assert.ok(Array.isArray(task.log));
  } finally {
    await ctx.close();
  }
});

test("an MCP approval pauses, then resumes and completes through the API", async () => {
  const ctx = await boot();
  try {
    const created = await ctx.json("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Tracker", url: "https://93.184.216.34/mcp", allowedTools: ["search"], description: "Demo" }),
    });
    assert.equal(created.response.status, 201);
    const connectorId = created.payload.connector.id;
    const state = await ctx.state();
    state.agents[0].mcpGrants = [{ connectorId, tools: ["search"] }];
    const updated = await ctx.json("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(updated.response.status, 200);

    const runId = await startRun(ctx, "[mcp] Look up the Acme account");
    const waiting = await waitForStatus(ctx, runId, ["waiting_approval"]);
    const approval = waiting.state.approvals.find((item) => item.mcp?.runId === runId);
    assert.ok(approval);
    assert.equal(approval.mcp.toolName, "search");
    assert.deepEqual(approval.mcp.arguments.query.includes("Acme"), true);

    const decision = await ctx.json(`/api/mcp/approvals/${approval.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decision.response.status, 202);
    assert.equal(decision.payload.runId, runId);
    await waitForStatus(ctx, runId, ["done"]);
    const final = await ctx.state();
    assert.equal(final.approvals.length, 0);
    assert.equal(final.tasks.find((item) => item.id === runId).assignments[0].status, "done");
    assert.ok(final.usage.totalTokens > 0);
  } finally {
    await ctx.close();
  }
});

test("live mode calls a Responses-compatible gateway and reports usage", async () => {
  const calls = [];
  const gatewayServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, body: JSON.parse(body) });
    const payload = JSON.parse(body);
    let text;
    if (payload.instructions.includes("Delegate the user's task")) {
      text = JSON.stringify({ summary: "Live plan", assignments: [{ employeeId: "maya", task: "Do the live work" }] });
    } else if (payload.instructions.includes("Synthesize employee results")) {
      text = "Live synthesized summary.";
    } else {
      text = "Live employee result.";
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "resp_live", output_text: text, usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }));
  });
  await new Promise((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gatewayServer.address().port;
  const fixture = await makeTestStore();
  const app = await startApplication({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      OPENAI_API_KEY: "test-key",
      AGENT_FACTORY_MODEL: "test-model",
      AGENT_FACTORY_DATA_DIR: fixture.dataDir,
      AGENT_FACTORY_SEED_FILE: fixture.seedFile,
    },
    port: 0,
    host: "127.0.0.1",
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.mode, "live");
    assert.equal(status.model, "test-model");
    const response = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A live task" }),
    });
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    const result = await waitFor(
      async () => {
        const state = await (await fetch(`${base}/api/state`)).json();
        const task = state.tasks.find((item) => item.id === runId);
        return task?.status === "done" ? { task, state } : null;
      },
      { label: "live completion" },
    );
    assert.equal(result.task.summary, "Live synthesized summary.");
    assert.equal(result.task.assignments[0].result, "Live employee result.");
    assert.equal(result.task.usage.totalTokens, 54);
    assert.equal(result.state.usage.totalTokens, 54);
    assert.ok(calls.every((call) => call.url === "/v1/responses"));
    assert.ok(calls.every((call) => call.body.model === "test-model"));
  } finally {
    await app.close();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await fixture.cleanup();
  }
});

test("a waiting run can be canceled and its approval is removed", async () => {
  const ctx = await boot();
  try {
    const created = await ctx.json("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Tracker", url: "https://93.184.216.34/mcp", allowedTools: ["search"] }),
    });
    const connectorId = created.payload.connector.id;
    const state = await ctx.state();
    state.agents[0].mcpGrants = [{ connectorId, tools: ["search"] }];
    await ctx.json("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });

    const runId = await startRun(ctx, "[mcp] Inspect the account");
    await waitForStatus(ctx, runId, ["waiting_approval"]);
    const del = await ctx.json(`/api/runs/${runId}`, { method: "DELETE" });
    assert.equal(del.response.status, 409);

    const canceled = await ctx.json(`/api/runs/${runId}/cancel`, { method: "POST" });
    assert.equal(canceled.response.status, 200);
    assert.equal(canceled.payload.task.status, "canceled");
    const final = await ctx.state();
    assert.equal(final.approvals.length, 0);
    assert.equal(final.tasks.find((item) => item.id === runId).status, "canceled");

    const removed = await ctx.json(`/api/runs/${runId}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.equal((await ctx.state()).tasks.length, 0);
  } finally {
    await ctx.close();
  }
});

test("state PUT is atomic and preserves server-owned runs and usage", async () => {
  const ctx = await boot();
  try {
    const runId = await startRun(ctx, "A small task");
    await waitForStatus(ctx, runId, ["done"]);
    const state = await ctx.state();
    state.agents[0].name = "Maya C.";
    state.tasks = [];
    state.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const response = await fetch(`${ctx.base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.agents[0].name, "Maya C.");
    assert.equal(saved.tasks.length, 1);
    assert.ok(saved.usage.totalTokens > 0);
  } finally {
    await ctx.close();
  }
});

test("backup, restore, and reset round-trip the workspace", async () => {
  const ctx = await boot();
  try {
    const before = await ctx.state();
    const backupResponse = await fetch(`${ctx.base}/api/workspace/backup`);
    assert.equal(backupResponse.status, 200);
    assert.match(backupResponse.headers.get("content-disposition"), /attachment/);
    const backup = await backupResponse.json();
    assert.equal(backup.kind, "agent-factory-workspace");
    assert.equal(backup.state.executive.name, before.executive.name);
    assert.equal("usage" in backup.state, true);

    const changed = await ctx.state();
    changed.tools.push({ name: "Linear", category: "Productivity", connected: true, glyph: "L", style: "" });
    await ctx.json("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changed) });
    assert.equal((await ctx.state()).tools.length, 3);

    const restored = await ctx.json("/api/workspace/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: backup.state }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal((await ctx.state()).tools.length, 2);

    const reset = await ctx.json("/api/workspace/reset", { method: "POST" });
    assert.equal(reset.response.status, 200);
    const state = await ctx.state();
    assert.equal(state.tasks.length, 0);
    assert.equal(state.usage.totalTokens, 0);
    assert.equal(state.agents.length, 2);
  } finally {
    await ctx.close();
  }
});

test("mutations reject cross-origin, non-JSON, and non-loopback requests", async () => {
  const ctx = await boot();
  try {
    const originResponse = await rawRequest(ctx.app.port, {
      method: "POST",
      path: "/api/workflows",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(originResponse.status, 403);

    const hostResponse = await rawRequest(ctx.app.port, {
      method: "GET",
      path: "/api/state",
      headers: { Host: "evil.example" },
    });
    assert.equal(hostResponse.status, 403);

    const contentType = await fetch(`${ctx.base}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(contentType.status, 415);

    const emptyPrompt = await fetch(`${ctx.base}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.equal(emptyPrompt.status, 400);

    const state = await ctx.state();
    state.connectors.push({ id: "conn_evil", label: "Evil", url: "https://93.184.216.34/mcp", allowedTools: ["x"], enabled: true });
    const connectorBypass = await fetch(`${ctx.base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(connectorBypass.status, 400);
  } finally {
    await ctx.close();
  }
});

function rawRequest(port, { method, path, headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
