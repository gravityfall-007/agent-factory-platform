import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowEngine } from "../lib/workflow.mjs";
import { HttpError } from "../lib/core.mjs";
import { baseSeed, makeTestStore, planPayload, response, sleep, usage, waitFor } from "./helpers.mjs";

const config = { configured: true, mode: "demo", model: "test-model", budget: 100_000 };

function demoGateway({ plan, employee, synthesis } = {}) {
  const calls = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      if (request.instructions.includes("Delegate the user's task")) {
        return response(plan || planPayload([{ employeeId: "maya", task: "Prepare the renewal plan" }]), { usage: usage(10, 10) });
      }
      if (request.instructions.includes("Synthesize employee results")) {
        return response(synthesis || "Synthesized result.", { usage: usage(5, 8) });
      }
      if (typeof employee === "function") return employee(request);
      return response("Employee result.", { usage: usage(7, 9) });
    },
  };
}

test("workflow runs plan, delegation, synthesis, and commits usage", async () => {
  const { store, cleanup } = await makeTestStore();
  try {
    const gateway = demoGateway();
    const engine = createWorkflowEngine({ store, gateway, config });
    const { runId } = await engine.start("Prepare a renewal plan for Acme");
    const { state, task } = await waitFor(
      async () => {
        const current = await store.getState();
        const found = current.tasks.find((item) => item.id === runId);
        return found && found.status === "done" ? { state: current, task: found } : null;
      },
      { label: "run completion" },
    );
    assert.equal(task.status, "done");
    assert.equal(task.assignments.length, 1);
    assert.equal(task.assignments[0].status, "done");
    assert.equal(task.assignments[0].result, "Employee result.");
    assert.equal(task.summary, "Synthesized result.");
    assert.equal(state.usage.totalTokens, 49);
    assert.equal(state.activities[0].kind, "complete");
    assert.equal(state.approvals.length, 0);
    assert.ok(task.log.some((entry) => entry.type === "plan"));
    assert.ok(task.log.some((entry) => entry.type === "synthesis"));

    const events = [];
    engine.subscribe(runId, (event) => events.push(event));
    const types = events.map((event) => event.type);
    for (const expected of ["run.started", "plan", "assignment.started", "assignment.completed", "run.synthesizing", "run.completed"]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
  } finally {
    await cleanup();
  }
});

test("an MCP approval pauses the run and resumes after a decision", async () => {
  const connector = { id: "conn_1", label: "Tracker", url: "https://93.184.216.34/mcp", description: "", allowedTools: ["search"], enabled: true };
  const seed = baseSeed({ connectors: [connector] });
  seed.agents[0].mcpGrants = [{ connectorId: "conn_1", tools: ["search"] }];
  const { store, cleanup } = await makeTestStore(seed);
  try {
    const gateway = demoGateway({
      plan: planPayload([{ employeeId: "maya", task: "Look up the account" }]),
      employee: (request) => {
        if (Array.isArray(request.input)) {
          return response("Approved tool result.", { usage: usage(3, 4), responseId: "resp_approved" });
        }
        return response("", {
          usage: usage(4, 2),
          responseId: "resp_waiting",
          mcpRequests: [{ id: "appr_1", type: "mcp_approval_request", name: "search", server_label: "conn_1", arguments: { query: "acme" } }],
        });
      },
    });
    const engine = createWorkflowEngine({ store, gateway, config });
    const { runId } = await engine.start("Look up the Acme account");
    const waiting = await waitFor(
      async () => {
        const state = await store.getState();
        const task = state.tasks.find((item) => item.id === runId);
        return task?.status === "waiting_approval" ? state : null;
      },
      { label: "approval pause" },
    );
    const approval = waiting.approvals.find((item) => item.mcp?.runId === runId);
    assert.ok(approval);
    assert.equal(approval.mcp.toolName, "search");
    assert.deepEqual(approval.mcp.arguments, { query: "acme" });
    assert.equal(waiting.tasks[0].assignments[0].status, "awaiting_approval");
    const pending = await store.getPending();
    assert.equal(Object.keys(pending).length, 1);

    const result = await engine.resumeApproval(approval.id, "approved");
    assert.equal(result.runId, runId);
    await waitFor(
      async () => {
        const state = await store.getState();
        return state.tasks.find((item) => item.id === runId)?.status === "done";
      },
      { label: "resumed completion" },
    );
    const final = await store.getState();
    const task = final.tasks.find((item) => item.id === runId);
    assert.equal(task.assignments[0].result, "Approved tool result.");
    assert.equal(task.status, "done");
    assert.equal(final.approvals.length, 0);
    assert.deepEqual(await store.getPending(), {});
    assert.ok(gateway.calls.some((call) => Array.isArray(call.input) && call.input[0].type === "mcp_approval_response"));
  } finally {
    await cleanup();
  }
});

test("a rejected MCP approval resumes without an external result and finishes", async () => {
  const connector = { id: "conn_1", label: "Tracker", url: "https://93.184.216.34/mcp", allowedTools: ["search"], enabled: true };
  const seed = baseSeed({ connectors: [connector] });
  seed.agents[0].mcpGrants = [{ connectorId: "conn_1", tools: ["search"] }];
  const { store, cleanup } = await makeTestStore(seed);
  try {
    const gateway = demoGateway({
      plan: planPayload([{ employeeId: "maya", task: "Look up the account" }]),
      employee: (request) =>
        Array.isArray(request.input)
          ? response("The call was rejected.", { usage: usage(2, 2) })
          : response("", {
              usage: usage(2, 1),
              responseId: "resp_waiting",
              mcpRequests: [{ id: "appr_1", type: "mcp_approval_request", name: "search", server_label: "conn_1", arguments: {} }],
            }),
    });
    const engine = createWorkflowEngine({ store, gateway, config });
    const { runId } = await engine.start("Look up the Acme account");
    const state = await waitFor(
      async () => {
        const current = await store.getState();
        return current.tasks.find((item) => item.id === runId)?.status === "waiting_approval" ? current : null;
      },
      { label: "approval pause" },
    );
    const approval = state.approvals.find((item) => item.mcp?.runId === runId);
    await engine.resumeApproval(approval.id, "rejected");
    await waitFor(
      async () => {
        const current = await store.getState();
        return current.tasks.find((item) => item.id === runId)?.status === "done";
      },
      { label: "rejected completion" },
    );
    const final = await store.getState();
    assert.equal(final.tasks.find((item) => item.id === runId).assignments[0].result, "The call was rejected.");
  } finally {
    await cleanup();
  }
});

test("a running workflow can be canceled and commits partial usage", async () => {
  const { store, cleanup } = await makeTestStore();
  try {
    const gateway = demoGateway({
      employee: (request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(response("late", { usage: usage(1, 1) })), 2000);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("canceled"), { name: "AbortError" }));
          });
        }),
    });
    const engine = createWorkflowEngine({ store, gateway, config });
    const { runId } = await engine.start("A long task");
    await waitFor(
      async () => {
        const state = await store.getState();
        return state.tasks.find((item) => item.id === runId)?.status === "running" ? state : null;
      },
      { label: "run start" },
    );
    const task = await engine.cancel(runId);
    assert.equal(task.status, "canceled");
    const final = await store.getState();
    assert.equal(final.tasks.find((item) => item.id === runId).status, "canceled");
    assert.ok(final.usage.totalTokens > 0);
    assert.equal(final.activities[0].kind, "reject");
  } finally {
    await cleanup();
  }
});

test("a queued run can be canceled before it starts", async () => {
  const { store, cleanup } = await makeTestStore();
  try {
    const gateway = demoGateway({
      employee: (request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(response("done")), 5000);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("canceled"), { name: "AbortError" }));
          });
        }),
    });
    const engine = createWorkflowEngine({ store, gateway, config, maxConcurrent: 1, maxQueued: 2 });
    const first = await engine.start("First");
    const second = await engine.start("Second");
    const third = await engine.start("Third");
    assert.deepEqual(
      engine.activeRuns().map((run) => run.status).sort(),
      ["queued", "queued", "running"],
    );
    const canceled = await engine.cancel(third.runId);
    assert.equal(canceled.status, "canceled");
    assert.ok(!engine.activeRuns().some((run) => run.runId === third.runId));
    // cleanup: cancel the remaining runs so the test process can exit
    await engine.cancel(first.runId).catch(() => {});
    await engine.cancel(second.runId).catch(() => {});
  } finally {
    await cleanup();
  }
});

test("hydrate restores a waiting approval and allows resuming after restart", async () => {
  const connector = { id: "conn_1", label: "Tracker", url: "https://93.184.216.34/mcp", allowedTools: ["search"], enabled: true };
  const seed = baseSeed({ connectors: [connector] });
  seed.agents[0].mcpGrants = [{ connectorId: "conn_1", tools: ["search"] }];
  const { store, cleanup } = await makeTestStore(seed);
  try {
    const task = {
      id: "run_recovered",
      prompt: "Look up the account",
      summary: "Waiting for human approval to use an external tool.",
      status: "waiting_approval",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: "",
      model: "test-model",
      usage: usage(5, 5),
      log: [],
      assignments: [
        { employeeId: "maya", employeeName: "Maya Chen", task: "Look it up", status: "awaiting_approval", result: "", usage: usage(0, 0) },
      ],
    };
    await store.updateState((workspace) => {
      workspace.tasks.unshift(task);
      workspace.approvals.unshift({
        id: "approval_1",
        agent: "Maya Chen",
        initials: "MC",
        action: "search on Tracker",
        detail: "Review",
        time: "just now",
        mcp: { connectorId: "conn_1", connectorLabel: "Tracker", toolName: "search", arguments: {}, runId: task.id },
      });
    });
    await store.updatePending((pending) => {
      pending.approval_1 = {
        taskId: task.id,
        runId: task.id,
        prompt: task.prompt,
        assignmentIndex: 0,
        employeeId: "maya",
        connectorId: "conn_1",
        toolName: "search",
        responseId: "resp_old",
        approvalRequestId: "appr_old",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    });
    const gateway = demoGateway({
      employee: (request) => response("Recovered result.", { usage: usage(2, 3) }),
    });
    const engine = createWorkflowEngine({ store, gateway, config });
    await engine.hydrate();
    assert.ok(engine.activeRuns().some((run) => run.runId === task.id && run.status === "waiting_approval"));
    await engine.resumeApproval("approval_1", "approved");
    await waitFor(
      async () => {
        const state = await store.getState();
        return state.tasks.find((item) => item.id === task.id)?.status === "done";
      },
      { label: "recovered completion" },
    );
    const final = await store.getState();
    assert.equal(final.tasks.find((item) => item.id === task.id).assignments[0].result, "Recovered result.");
  } finally {
    await cleanup();
  }
});

test("hydrate fails a waiting task whose pending approval record was lost", async () => {
  const seed = baseSeed();
  const { store, cleanup } = await makeTestStore(seed);
  try {
    await store.updateState((workspace) => {
      workspace.tasks.unshift({
        id: "run_lost",
        prompt: "Lost approval",
        status: "waiting_approval",
        createdAt: new Date().toISOString(),
        assignments: [{ employeeId: "maya", employeeName: "Maya Chen", task: "Do it", status: "awaiting_approval" }],
      });
    });
    const engine = createWorkflowEngine({ store, gateway: demoGateway(), config });
    await engine.hydrate();
    const state = await store.getState();
    const task = state.tasks[0];
    assert.equal(task.status, "failed");
    assert.match(task.summary, /approval record/i);
  } finally {
    await cleanup();
  }
});

test("the local token budget blocks new runs", async () => {
  const seed = baseSeed({ usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } });
  const { store, cleanup } = await makeTestStore(seed);
  try {
    const engine = createWorkflowEngine({ store, gateway: demoGateway(), config: { ...config, budget: 200 } });
    await assert.rejects(() => engine.start("Too expensive"), (error) => error instanceof HttpError && error.status === 429);
    assert.equal((await store.getState()).tasks.length, 0);
  } finally {
    await cleanup();
  }
});

test("plan parsing rejects malformed model output", async () => {
  const { store, cleanup } = await makeTestStore();
  try {
    const gateway = demoGateway({ plan: "not json" });
    const engine = createWorkflowEngine({ store, gateway, config });
    const { runId } = await engine.start("Bad plan");
    const state = await waitFor(
      async () => {
        const current = await store.getState();
        const task = current.tasks.find((item) => item.id === runId);
        return task?.status === "failed" ? current : null;
      },
      { label: "failed run" },
    );
    const task = state.tasks.find((item) => item.id === runId);
    assert.match(task.summary, /invalid delegation plan/);
    await sleep(10);
  } finally {
    await cleanup();
  }
});
