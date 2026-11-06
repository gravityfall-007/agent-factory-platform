/**
 * Executive workflow engine.
 *
 * A run is an in-memory process with a persisted task mirror. Every step emits
 * an event (streamed over SSE) and important transitions are written to the
 * workspace store so the run survives a page reload and renders as history.
 */
import { randomUUID } from "node:crypto";
import {
  HttpError,
  MAX_ACTIVITIES,
  MAX_CONCURRENT_RUNS,
  MAX_HISTORY,
  MAX_QUEUED_RUNS,
  MAX_TASK_LOG,
} from "./core.mjs";

const nowIso = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const initialsOf = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(target, usage) {
  if (!usage) return;
  target.inputTokens += usage.inputTokens || 0;
  target.outputTokens += usage.outputTokens || 0;
  target.totalTokens += usage.totalTokens || 0;
}

export function parseDelegationPlan(text, eligibleAgents) {
  const normalized = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let plan;
  try {
    plan = JSON.parse(normalized);
  } catch {
    throw new HttpError(502, "The executive agent returned an invalid delegation plan. Try a more specific task.");
  }
  if (!Array.isArray(plan?.assignments)) {
    throw new HttpError(502, "The executive agent returned an invalid delegation plan. Try again.");
  }
  const eligible = new Map(eligibleAgents.map((agent) => [agent.id, agent]));
  const assignments = [];
  const seen = new Set();
  for (const candidate of plan.assignments) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.employeeId !== "string" || typeof candidate.task !== "string") continue;
    const employee = eligible.get(candidate.employeeId);
    const task = candidate.task.trim();
    if (!employee || seen.has(employee.id) || !task) continue;
    seen.add(employee.id);
    assignments.push({
      employeeId: employee.id,
      employeeName: employee.name,
      task: task.slice(0, 2000),
      status: "pending",
      result: "",
      error: "",
      startedAt: null,
      completedAt: null,
      usage: emptyUsage(),
    });
    if (assignments.length === 3) break;
  }
  if (!assignments.length) {
    throw new HttpError(502, "The executive agent did not assign work to an available employee. Try a more specific task.");
  }
  return {
    summary: typeof plan.summary === "string" ? plan.summary.trim().slice(0, 1000) : "",
    assignments,
  };
}

function makeActivity(agent, action, target, detail, kind = "complete", icon = "✦") {
  return { id: randomUUID(), kind, icon, agent, action, target, detail, time: "just now" };
}

const isTerminalStatus = (status) => ["done", "failed", "canceled"].includes(status);

export function createWorkflowEngine({
  store,
  gateway,
  config,
  connectorValidator,
  maxConcurrent = MAX_CONCURRENT_RUNS,
  maxQueued = MAX_QUEUED_RUNS,
  logger = console,
}) {
  const runs = new Map();
  const queue = [];
  let activeCount = 0;

  function createRun(task) {
    const run = {
      id: task.id,
      task,
      status: "queued",
      events: [],
      subscribers: new Set(),
      seq: 0,
      controller: new AbortController(),
      cancelRequested: false,
      finalized: false,
      usageCommitted: false,
      resumeInFlight: false,
      startedAt: null,
    };
    runs.set(run.id, run);
    return run;
  }

  function emit(run, type, data = {}) {
    const event = { seq: ++run.seq, at: nowIso(), type, data };
    run.events.push(event);
    if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
    for (const subscriber of run.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* a broken SSE client must never break a run */
      }
    }
    return event;
  }

  function log(run, type, message) {
    run.task.log.push({ at: nowIso(), type, message: String(message).slice(0, 600) });
    if (run.task.log.length > MAX_TASK_LOG) run.task.log.splice(0, run.task.log.length - MAX_TASK_LOG);
  }

  async function persist(run) {
    run.task.updatedAt = nowIso();
    const snapshot = clone(run.task);
    await store.updateState((state) => {
      const index = state.tasks.findIndex((item) => item.id === snapshot.id);
      if (index === -1) state.tasks.unshift(snapshot);
      else state.tasks[index] = snapshot;
      state.tasks = state.tasks.slice(0, MAX_HISTORY);
    });
  }

  async function finish(run, { status, summary, error = "" }) {
    if (run.finalized) return;
    run.finalized = true;
    run.status = status;
    const task = run.task;
    task.status = status;
    task.summary = summary;
    task.error = error;
    task.completedAt = nowIso();
    task.updatedAt = task.completedAt;
    for (const assignment of task.assignments) {
      if (["working", "awaiting_approval", "pending"].includes(assignment.status)) {
        assignment.status = status === "canceled" ? "skipped" : "failed";
        assignment.completedAt ||= task.completedAt;
      }
    }
    const snapshot = clone(task);
    const usage = snapshot.usage;
    const commitUsage = !run.usageCommitted;
    await store.updateState((state) => {
      const index = state.tasks.findIndex((item) => item.id === snapshot.id);
      if (index === -1) state.tasks.unshift(snapshot);
      else state.tasks[index] = snapshot;
      state.tasks = state.tasks.slice(0, MAX_HISTORY);
      state.approvals = state.approvals.filter((item) => item.mcp?.runId !== snapshot.id);
      if (commitUsage) {
        state.usage.inputTokens += usage.inputTokens || 0;
        state.usage.outputTokens += usage.outputTokens || 0;
        state.usage.totalTokens += usage.totalTokens || 0;
      }
      const verb =
        status === "done"
          ? "completed an employee task workflow for"
          : status === "canceled"
            ? "canceled a workflow for"
            : "could not complete the workflow for";
      state.activities.unshift(
        makeActivity(
          state.executive.name,
          verb,
          snapshot.prompt.slice(0, 180),
          status === "done"
            ? `${snapshot.assignments.length} employee agents · ${Number(usage.totalTokens || 0).toLocaleString("en-US")} tokens`
            : summary.slice(0, 300),
          status === "done" ? "complete" : "reject",
          status === "done" ? "✦" : status === "canceled" ? "■" : "!",
        ),
      );
      state.activities = state.activities.slice(0, MAX_ACTIVITIES);
    });
    run.usageCommitted = true;
    scheduleCleanup(run);
  }

  function scheduleCleanup(run) {
    const timer = setTimeout(() => {
      if (run.subscribers.size === 0) runs.delete(run.id);
    }, 15 * 60_000);
    timer.unref?.();
  }

  async function fail(run, error) {
    if (run.finalized) return;
    const canceled = run.cancelRequested || run.controller.signal.aborted || error?.name === "AbortError";
    const message = canceled
      ? "Run canceled by the operator."
      : error instanceof HttpError
        ? error.message
        : "A model agent could not complete the workflow. Check the gateway settings and try again.";
    if (!canceled && !(error instanceof HttpError)) logger.error?.(`Workflow run failed (${error?.name || "error"}).`);
    log(run, canceled ? "canceled" : "failed", message);
    await finish(run, { status: canceled ? "canceled" : "failed", summary: message, error: canceled ? "canceled" : "failed" });
    emit(run, canceled ? "run.canceled" : "run.failed", { message, usage: clone(run.task.usage) });
  }

  function releaseSlot() {
    activeCount = Math.max(0, activeCount - 1);
    pump();
  }

  function pump() {
    while (activeCount < maxConcurrent && queue.length) {
      const runId = queue.shift();
      const run = runs.get(runId);
      if (!run || run.status !== "queued" || run.cancelRequested) continue;
      launch(run);
    }
  }

  function launch(run) {
    activeCount += 1;
    run.status = "running";
    run.startedAt = nowIso();
    run.task.status = "running";
    emit(run, "run.started", { model: config.model || null, mode: config.mode });
    log(run, "started", "Executive planning started.");
    execute(run)
      .catch((error) => fail(run, error))
      .finally(() => releaseSlot());
  }

  function activeRuns() {
    return [...runs.values()]
      .filter((run) => !run.finalized)
      .map((run) => ({
        runId: run.id,
        status: run.status,
        prompt: run.task.prompt.slice(0, 200),
        startedAt: run.startedAt || run.task.createdAt,
        queued: queue.includes(run.id),
      }));
  }

  async function hydrate() {
    const state = await store.getState();
    const pending = await store.getPending();
    const covered = new Set(Object.values(pending).map((record) => record.taskId));
    for (const task of state.tasks) {
      if (task.status !== "waiting_approval" || runs.has(task.id)) continue;
      const run = createRun(clone(task));
      run.status = "waiting_approval";
      run.recovered = true;
      if (!covered.has(task.id)) {
        log(run, "failed", "The pending approval record is missing after a restart.");
        await finish(run, {
          status: "failed",
          summary: "The pending approval record was lost after a restart. Start a new run.",
          error: "interrupted",
        });
        emit(run, "run.failed", { message: "The pending approval record was lost after a restart." });
      } else {
        emit(run, "run.recovered", { status: "waiting_approval" });
      }
    }
  }

  async function start(prompt) {
    const state = await store.getState();
    if (state.usage.totalTokens >= config.budget) {
      throw new HttpError(
        429,
        `The local token budget of ${Number(config.budget).toLocaleString("en-US")} is used up. Raise AGENT_FACTORY_TOKEN_BUDGET or reset the demo workspace.`,
      );
    }
    if (activeCount >= maxConcurrent && queue.length >= maxQueued) {
      throw new HttpError(429, "The run queue is full. Wait for an active run to finish or cancel one.");
    }
    const task = {
      id: `run_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      prompt,
      summary: "",
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      error: "",
      model: config.model || "",
      usage: emptyUsage(),
      log: [],
      assignments: [],
    };
    await store.updateState((workspace) => {
      workspace.tasks.unshift(task);
      workspace.tasks = workspace.tasks.slice(0, MAX_HISTORY);
    });
    const run = createRun(clone(task));
    log(run, "queued", "Run accepted and waiting for a slot.");
    if (activeCount < maxConcurrent) {
      emit(run, "run.queued", { prompt });
      launch(run);
    } else {
      queue.push(run.id);
      task.summary = "Queued behind active runs.";
      emit(run, "run.queued", { position: queue.length, prompt });
      await persist(run);
    }
    return { runId: run.id, task: clone(run.task) };
  }

  async function mcpToolsFor(employee, state) {
    const secrets = await store.getSecrets();
    const entries = await Promise.all(
      employee.mcpGrants.map(async (grant) => {
        const connector = state.connectors.find((item) => item.id === grant.connectorId && item.enabled);
        if (!connector) return null;
        const allowed = grant.tools.filter((name) => connector.allowedTools.includes(name));
        if (!allowed.length) return null;
        if (config.mode !== "demo" && connectorValidator) await connectorValidator(connector.url);
        return {
          type: "mcp",
          server_label: connector.id,
          server_description: connector.description || connector.label,
          server_url: connector.url,
          require_approval: "always",
          allowed_tools: allowed,
          ...(secrets[connector.id] ? { authorization: secrets[connector.id] } : {}),
        };
      }),
    );
    return entries.filter(Boolean);
  }

  function toolForRequest(requestItem, employee, state) {
    if (!requestItem || typeof requestItem !== "object") throw new HttpError(502, "The model returned an invalid MCP request.");
    const toolName = typeof requestItem.name === "string" ? requestItem.name : "";
    const connector = state.connectors.find((item) => item.id === requestItem.server_label && item.enabled);
    const grant = employee.mcpGrants.find((item) => item.connectorId === connector?.id);
    if (!connector || !grant || !toolName || !grant.tools.includes(toolName) || !connector.allowedTools.includes(toolName)) {
      throw new HttpError(502, "The model requested an MCP tool outside this employee's permissions.");
    }
    return { connector, toolName };
  }

  async function requestApproval(run, task, state, index, employee, result) {
    const request = result.mcpRequests[0];
    if (!request) throw new HttpError(502, "The model returned no MCP approval request.");
    const { connector, toolName } = toolForRequest(request, employee, state);
    if (!result.responseId) throw new HttpError(502, "The model gateway response could not be resumed safely.");
    if (!request.id) throw new HttpError(502, "The model gateway returned an approval request without an ID.");
    const approvalId = randomUUID();
    await store.updatePending((pending) => {
      pending[approvalId] = {
        taskId: task.id,
        runId: run.id,
        prompt: task.prompt,
        assignmentIndex: index,
        employeeId: employee.id,
        connectorId: connector.id,
        toolName,
        responseId: result.responseId,
        approvalRequestId: String(request.id),
        createdAt: nowIso(),
      };
    });

    task.status = "waiting_approval";
    task.summary = "Waiting for human approval to use an external tool.";
    task.updatedAt = nowIso();
    task.assignments[index].status = "awaiting_approval";
    run.status = "waiting_approval";
    log(run, "approval", `${employee.name} requested ${toolName} on ${connector.label}.`);

    const approval = {
      id: approvalId,
      agent: employee.name,
      initials: initialsOf(employee.name),
      action: `${toolName} on ${connector.label}`,
      detail: "Review the arguments before approving this external tool call.",
      time: "just now",
      createdAt: nowIso(),
      mcp: {
        connectorId: connector.id,
        connectorLabel: connector.label,
        toolName,
        arguments: request.arguments && typeof request.arguments === "object" ? request.arguments : {},
        runId: run.id,
      },
    };
    const snapshot = clone(task);
    await store.updateState((workspace) => {
      workspace.approvals.unshift(approval);
      const taskIndex = workspace.tasks.findIndex((item) => item.id === snapshot.id);
      if (taskIndex === -1) workspace.tasks.unshift(snapshot);
      else workspace.tasks[taskIndex] = snapshot;
      workspace.tasks = workspace.tasks.slice(0, MAX_HISTORY);
    });
    emit(run, "approval.required", {
      approvalId,
      runId: run.id,
      employeeName: employee.name,
      connectorId: connector.id,
      connectorLabel: connector.label,
      toolName,
      arguments: approval.mcp.arguments,
    });
    emit(run, "run.waiting_approval", { approvalId });
    return {
      id: approvalId,
      runId: run.id,
      employeeName: employee.name,
      connectorId: connector.id,
      connectorLabel: connector.label,
      toolName,
      arguments: approval.mcp.arguments,
    };
  }

  function employeeInstructions(employee, state) {
    const labels = (employee.tools || []).filter((name) => state.tools.some((tool) => tool.name === name && tool.connected));
    return `You are ${employee.name}, a digital employee working as ${employee.role} in ${employee.branch}. Capabilities: ${(employee.capabilities || []).join(", ") || "not specified"}. Internal tool permission labels: ${labels.join(", ") || "none"}. These labels are metadata only; never claim to have used them. Use only the external MCP tools explicitly provided and follow their results accurately. Provide a concrete work result and state assumptions.`;
  }

  async function assignRemaining(run, task, state, startIndex) {
    for (let index = startIndex; index < task.assignments.length; index += 1) {
      if (run.cancelRequested) throw Object.assign(new Error("canceled"), { name: "AbortError" });
      const assignment = task.assignments[index];
      const employee = state.agents.find((item) => item.id === assignment.employeeId);
      if (!employee) {
        assignment.status = "skipped";
        assignment.error = "Employee is no longer available.";
        assignment.completedAt = nowIso();
        emit(run, "assignment.skipped", {
          index,
          employeeId: assignment.employeeId,
          employeeName: assignment.employeeName,
          reason: assignment.error,
        });
        continue;
      }
      assignment.status = "working";
      assignment.startedAt = nowIso();
      task.status = "running";
      log(run, "assignment", `${employee.name} started: ${assignment.task.slice(0, 180)}`);
      emit(run, "assignment.started", {
        index,
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role,
        branch: employee.branch,
        task: assignment.task,
      });
      await persist(run);
      const tools = await mcpToolsFor(employee, state);
      const result = await gateway.call({
        instructions: employeeInstructions(employee, state),
        input: `Executive task: ${task.prompt}\n\nYour assignment: ${assignment.task}`,
        maxOutputTokens: 1200,
        tools,
        signal: run.controller.signal,
      });
      addUsage(task.usage, result.usage);
      assignment.usage = result.usage;
      if (result.mcpRequests.length) {
        const pendingApproval = await requestApproval(run, task, state, index, employee, result);
        return { waiting: true, pendingApproval };
      }
      assignment.result = result.text || "";
      assignment.status = "done";
      assignment.completedAt = nowIso();
      emit(run, "assignment.completed", {
        index,
        employeeId: employee.id,
        employeeName: employee.name,
        result: assignment.result,
        usage: result.usage,
      });
      log(run, "result", `${employee.name} returned a result.`);
      await persist(run);
    }
    await synthesize(run, task, state);
    return { waiting: false };
  }

  async function synthesize(run, task, state) {
    emit(run, "run.synthesizing", { employeeCount: task.assignments.length });
    log(run, "synthesis", "Executive synthesis started.");
    const result = await gateway.call({
      instructions: `You are ${state.executive.name}, the executive agent. Synthesize employee results into a concise response. Distinguish completed work from external actions and surface assumptions. Never claim that a metadata-only tool was used.`,
      input: `Original task:\n${task.prompt}\n\nEmployee results (JSON):\n${JSON.stringify(
        task.assignments.map(({ employeeName, task: assignedTask, result: text }) => ({ employeeName, task: assignedTask, result: text })),
      )}`,
      maxOutputTokens: 1400,
      signal: run.controller.signal,
    });
    addUsage(task.usage, result.usage);
    const summary = result.text || "The executive agent returned no summary.";
    await finish(run, { status: "done", summary });
    emit(run, "run.completed", { summary, usage: clone(task.usage), assignments: task.assignments.length });
  }

  async function execute(run) {
    const state = await store.getState();
    if (run.cancelRequested) throw Object.assign(new Error("canceled"), { name: "AbortError" });
    const activeAgents = state.agents.filter((agent) => agent.status === "active");
    if (!activeAgents.length) throw new HttpError(422, "Add or activate at least one employee agent before assigning work.");
    const roster = activeAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      branch: agent.branch,
      managerId: agent.managerId,
      capabilities: agent.capabilities,
      availableTools: agent.tools.filter((name) => state.tools.some((tool) => tool.name === name && tool.connected)),
    }));
    const planResult = await gateway.call({
      instructions: `You are ${state.executive.name}, the executive agent. Delegate the user's task to the smallest useful set of employees, at most three. Return only a JSON object with this shape: {"summary":"brief plan","assignments":[{"employeeId":"exact roster id","task":"bounded instruction"}]}. Use only employee IDs in the roster. Never invent that a tool or external system was accessed; internal tool labels are metadata only.`,
      input: `User task:\n${run.task.prompt}\n\nAvailable employees (JSON):\n${JSON.stringify(roster)}`,
      maxOutputTokens: 900,
      signal: run.controller.signal,
    });
    addUsage(run.task.usage, planResult.usage);
    log(run, "plan", "Executive delegation plan received.");
    const plan = parseDelegationPlan(planResult.text, activeAgents);
    run.task.assignments = plan.assignments;
    run.task.updatedAt = nowIso();
    emit(run, "plan", {
      summary: plan.summary,
      assignments: plan.assignments.map(({ employeeId, employeeName, task }) => ({ employeeId, employeeName, task })),
      usage: planResult.usage,
    });
    await persist(run);
    await assignRemaining(run, run.task, state, 0);
  }

  async function resumeApproval(approvalId, decision) {
    const pending = await store.getPending();
    const record = pending[approvalId];
    if (!record) throw new HttpError(404, "Pending approval not found.");
    const state = await store.getState();
    const storedTask = state.tasks.find((item) => item.id === record.taskId);
    const employee = state.agents.find((item) => item.id === record.employeeId);
    if (!storedTask || !employee) throw new HttpError(409, "The workflow or employee is no longer available.");
    if (isTerminalStatus(storedTask.status)) throw new HttpError(409, "This run has already finished.");

    const run = runs.get(record.runId) || createRecoveredRun(storedTask);
    if (run.resumeInFlight || run.status === "running") throw new HttpError(409, "This run is already being resumed.");
    // Adopt the persisted task so logs and nested mutations are written consistently.
    run.task = clone(storedTask);
    const task = run.task;
    run.resumeInFlight = true;
    run.cancelRequested = false;
    run.controller = new AbortController();
    run.status = "running";
    task.status = "running";
    task.summary = "";
    task.updatedAt = nowIso();
    emit(run, "approval.resolved", { approvalId, decision });
    log(run, "approval", `External tool call ${decision === "approved" ? "approved" : "rejected"}.`);

    try {
      const tools = await mcpToolsFor(employee, state);
      if (!tools.length) throw new HttpError(409, "The employee no longer has an enabled MCP tool grant.");
      const result = await gateway.call({
        instructions: `Continue the employee task for ${employee.name}. Use only the granted MCP tools and report results accurately.`,
        input: [{ type: "mcp_approval_response", approve: decision === "approved", approval_request_id: record.approvalRequestId }],
        maxOutputTokens: 1200,
        tools,
        previousResponseId: record.responseId,
        signal: run.controller.signal,
      });
      addUsage(task.usage, result.usage);

      // Remove the pending record only after the gateway accepted the decision.
      await store.updatePending((pending) => {
        delete pending[approvalId];
      });

      if (result.mcpRequests.length) {
        const next = await requestApproval(run, task, state, record.assignmentIndex, employee, result);
        await store.updateState((workspace) => {
          workspace.approvals = workspace.approvals.filter((item) => item.id !== approvalId);
        });
        run.resumeInFlight = false;
        return { runId: run.id, task: clone(run.task), pendingApproval: next };
      }

      const assignment = task.assignments[record.assignmentIndex];
      if (!assignment) throw new HttpError(409, "The assignment is no longer available.");
      assignment.status = "done";
      assignment.result = result.text || (decision === "approved" ? "The external tool call was approved." : "The external tool call was declined.");
      assignment.completedAt = nowIso();
      assignment.usage = result.usage;
      task.status = "running";
      task.updatedAt = nowIso();
      emit(run, "assignment.completed", {
        index: record.assignmentIndex,
        employeeId: employee.id,
        employeeName: employee.name,
        result: assignment.result,
        usage: result.usage,
      });
      emit(run, "approval.completed", { approvalId, decision });
      const snapshot = clone(task);
      await store.updateState((workspace) => {
        workspace.approvals = workspace.approvals.filter((item) => item.id !== approvalId);
        const index = workspace.tasks.findIndex((item) => item.id === snapshot.id);
        if (index === -1) workspace.tasks.unshift(snapshot);
        else workspace.tasks[index] = snapshot;
        workspace.tasks = workspace.tasks.slice(0, MAX_HISTORY);
      });

      run.resumeInFlight = false;
      // Continue in the background so the approval request returns promptly.
      assignRemaining(run, run.task, state, record.assignmentIndex + 1).catch((error) => fail(run, error));
      return { runId: run.id, task: clone(run.task) };
    } catch (error) {
      run.resumeInFlight = false;
      run.status = "waiting_approval";
      task.status = "waiting_approval";
      task.updatedAt = nowIso();
      await persist(run).catch(() => {});
      emit(run, "approval.error", {
        approvalId,
        message: error instanceof HttpError ? error.message : "The approval could not be processed.",
      });
      throw error;
    }
  }

  function createRecoveredRun(storedTask) {
    const run = createRun(clone(storedTask));
    run.status = storedTask.status === "waiting_approval" ? "waiting_approval" : "running";
    run.recovered = true;
    emit(run, "run.recovered", { status: storedTask.status });
    return run;
  }

  function waitForFinish(run, timeoutMs = 5000) {
    if (run.finalized) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (run.finalized || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(run.finalized);
        }
      }, 50);
      timer.unref?.();
    });
  }

  async function cancel(runId) {
    const state = await store.getState();
    const storedTask = state.tasks.find((item) => item.id === runId);
    if (!storedTask) throw new HttpError(404, "Run not found.");
    if (isTerminalStatus(storedTask.status)) throw new HttpError(409, "This run has already finished.");

    const pending = await store.getPending();
    const approvalIds = Object.entries(pending)
      .filter(([, record]) => record.taskId === runId)
      .map(([id]) => id);
    if (approvalIds.length) {
      await store.updatePending((current) => {
        for (const id of approvalIds) delete current[id];
      });
      await store.updateState((workspace) => {
        workspace.approvals = workspace.approvals.filter((item) => !approvalIds.includes(item.id));
      });
    }

    const run = runs.get(runId);
    if (!run) {
      const canceledAt = nowIso();
      await store.updateState((workspace) => {
        const target = workspace.tasks.find((item) => item.id === runId);
        if (!target) return;
        target.status = "canceled";
        target.summary = "Run canceled by the operator.";
        target.completedAt = canceledAt;
        target.updatedAt = canceledAt;
        for (const assignment of target.assignments) {
          if (["pending", "working", "awaiting_approval"].includes(assignment.status)) assignment.status = "skipped";
        }
        workspace.activities.unshift(makeActivity(workspace.executive.name, "canceled a workflow for", target.prompt.slice(0, 180), "Canceled before the run process was resumed.", "reject", "■"));
        workspace.activities = workspace.activities.slice(0, MAX_ACTIVITIES);
      });
      return (await store.getState()).tasks.find((item) => item.id === runId);
    }

    run.cancelRequested = true;
    run.controller.abort();
    const queueIndex = queue.indexOf(run.id);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);

    if (run.status === "queued" || run.status === "waiting_approval" || run.finalized) {
      // No in-flight gateway call will observe the abort; finalize here.
      run.task.status = "canceled";
      log(run, "canceled", "Run canceled by the operator.");
      await finish(run, { status: "canceled", summary: "Run canceled by the operator.", error: "canceled" });
      emit(run, "run.canceled", { message: "Run canceled by the operator." });
      return clone(run.task);
    }

    await waitForFinish(run);
    return clone(run.task);
  }

  function subscribe(runId, listener) {
    const run = runs.get(runId);
    if (!run) return null;
    for (const event of run.events) listener(event);
    run.subscribers.add(listener);
    return () => run.subscribers.delete(listener);
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    return { id: run.id, status: run.status, prompt: run.task.prompt, startedAt: run.startedAt };
  }

  function shutdown() {
    for (const run of runs.values()) {
      if (!run.finalized) {
        run.cancelRequested = true;
        run.controller.abort();
      }
    }
  }

  return { start, resumeApproval, cancel, subscribe, getRun, activeRuns, hydrate, shutdown };
}
