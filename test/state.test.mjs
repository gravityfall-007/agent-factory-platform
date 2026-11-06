import test from "node:test";
import assert from "node:assert/strict";
import { validateState, HttpError } from "../lib/core.mjs";
import { baseSeed } from "./helpers.mjs";

test("validateState fills defaults and keeps schema version", () => {
  const state = validateState(baseSeed());
  assert.equal(state.schemaVersion, 4);
  assert.deepEqual(state.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(state.agents[0].mcpGrants.length, 0);
  assert.equal(state.executive.mcpGrants.length, 0);
  assert.deepEqual(state.operator, { name: "Jordan Davis", role: "Workspace admin" });
  assert.ok(state.branches.includes("San Francisco"));
  assert.ok(state.branches.includes("Berlin"));
});

test("validateState derives usage from tasks when the workspace has no totals", () => {
  const seed = baseSeed({
    tasks: [
      {
        id: "run_1",
        prompt: "Do the thing",
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        assignments: [],
      },
    ],
  });
  delete seed.usage;
  const state = validateState(seed);
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(state.tasks[0].status, "done");
  assert.equal(state.tasks[0].updatedAt, "2026-01-01T00:00:00.000Z");
});

test("validateState infers assignment status from an existing result", () => {
  const seed = baseSeed({
    tasks: [
      {
        id: "run_old",
        prompt: "Legacy run",
        status: "waiting_approval",
        createdAt: "2026-01-01T00:00:00.000Z",
        assignments: [{ employeeId: "maya", employeeName: "Maya Chen", task: "Do it", result: "Done" }],
      },
    ],
  });
  const state = validateState(seed);
  assert.equal(state.tasks[0].assignments[0].status, "done");
  assert.equal(state.tasks[0].completedAt, null);
});

test("validateState rejects unknown task statuses", () => {
  const seed = baseSeed({
    tasks: [{ id: "run_1", prompt: "x", status: "exploded", createdAt: "2026-01-01T00:00:00.000Z", assignments: [] }],
  });
  assert.throws(() => validateState(seed), (error) => error instanceof HttpError && error.status === 400);
});

test("validateState rejects duplicate employee and connector ids", () => {
  const duplicateAgents = baseSeed({ agents: [baseSeed().agents[0], baseSeed().agents[0]] });
  assert.throws(() => validateState(duplicateAgents), /unique/);
  const duplicateConnectors = baseSeed({
    connectors: [
      { id: "c1", label: "A", url: "https://example.com/mcp", allowedTools: ["x"] },
      { id: "c1", label: "B", url: "https://example.com/mcp", allowedTools: ["x"] },
    ],
  });
  assert.throws(() => validateState(duplicateConnectors), /unique/);
});

test("validateState requires branches used by employees to remain listed", () => {
  const seed = baseSeed({ branches: ["Berlin"] });
  assert.throws(() => validateState(seed), /still assigned/);
  const withBranches = baseSeed({ branches: ["San Francisco", "Berlin"] });
  assert.deepEqual(validateState(withBranches).branches, ["San Francisco", "Berlin"]);
});

test("validateState rejects grants outside the connector allow-list", () => {
  const seed = baseSeed({
    connectors: [{ id: "conn_1", label: "Tracker", url: "https://example.com/mcp", allowedTools: ["search"] }],
  });
  seed.agents[0].mcpGrants = [{ connectorId: "conn_1", tools: ["delete_everything"] }];
  assert.throws(() => validateState(seed), /outside the connector/);
});

test("validateState bounds prompts and rejects invalid MCP arguments", () => {
  const tooLongPrompt = baseSeed({
    tasks: [
      {
        id: "run_1",
        prompt: "x".repeat(7000),
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        assignments: [],
      },
    ],
  });
  assert.throws(() => validateState(tooLongPrompt), /6000/);

  const badApproval = baseSeed({
    approvals: [
      {
        id: "a1",
        agent: "Maya",
        action: "Use tool",
        mcp: { connectorId: "conn_1", connectorLabel: "Tracker", toolName: "search", arguments: [] },
      },
    ],
  });
  assert.throws(() => validateState(badApproval), /arguments/);
});

test("validateState strips unknown fields from persisted tasks", () => {
  const seed = baseSeed({
    tasks: [
      {
        id: "run_1",
        prompt: "x",
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        assignments: [],
        secretField: "do-not-persist",
      },
    ],
  });
  const state = validateState(seed);
  assert.equal("secretField" in state.tasks[0], false);
});
