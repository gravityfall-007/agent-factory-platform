/**
 * Durable workspace store.
 *
 * All state, connector secrets, and pending approvals live in one owner-only
 * data directory. Writes are serialized, atomic (temp file + rename), and the
 * in-memory copy is only updated after the write succeeds.
 */
import { readFile, mkdir, rename, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateState } from "./core.mjs";

const clone = (value) => structuredClone(value);

export function createStore({ dataDir, seedFile }) {
  const stateFile = path.join(dataDir, "workspace.json");
  const secretsFile = path.join(dataDir, "connector-secrets.json");
  const pendingFile = path.join(dataDir, "pending-approvals.json");

  let cachedState;
  let loaded = false;
  let queue = Promise.resolve();
  let secretsCache;
  let pendingCache;

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      if (error instanceof SyntaxError) throw new Error(`Corrupt data file: ${path.basename(file)}`);
      throw error;
    }
  }

  async function writePrivate(file, value) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700).catch(() => {});
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, file);
  }

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = await readFile(stateFile, "utf8");
      cachedState = validateState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      cachedState = validateState(JSON.parse(await readFile(seedFile, "utf8")));
      await writePrivate(stateFile, cachedState);
    }
    // Runs that were active when the process stopped can never finish; mark
    // them clearly instead of leaving a spinner forever in the UI.
    let repaired = false;
    for (const task of cachedState.tasks) {
      if (task.status === "queued" || task.status === "running") {
        task.status = "failed";
        task.summary = "Interrupted by a server restart. Start a new run.";
        task.error = "interrupted";
        task.completedAt = new Date().toISOString();
        task.updatedAt = task.completedAt;
        for (const assignment of task.assignments) {
          if (assignment.status === "working" || assignment.status === "pending") {
            assignment.status = "failed";
            assignment.error = "interrupted";
          }
        }
        repaired = true;
      }
    }
    if (repaired) await writePrivate(stateFile, cachedState);
    loaded = true;
  }

  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  async function getState() {
    await queue;
    await ensureLoaded();
    return clone(cachedState);
  }

  function replaceState(input) {
    const safe = validateState(input);
    return enqueue(async () => {
      await ensureLoaded();
      await writePrivate(stateFile, safe);
      cachedState = safe;
      return clone(cachedState);
    });
  }

  function updateState(mutator) {
    return enqueue(async () => {
      await ensureLoaded();
      const next = clone(cachedState);
      await mutator(next);
      const safe = validateState(next);
      await writePrivate(stateFile, safe);
      cachedState = safe;
      return clone(cachedState);
    });
  }

  async function getSecrets() {
    await queue;
    if (!secretsCache) secretsCache = await readJson(secretsFile, {});
    return clone(secretsCache);
  }

  function saveSecrets(value) {
    return enqueue(async () => {
      await writePrivate(secretsFile, value);
      secretsCache = clone(value);
    });
  }

  function updateSecrets(mutator) {
    return enqueue(async () => {
      if (!secretsCache) secretsCache = await readJson(secretsFile, {});
      const next = clone(secretsCache);
      await mutator(next);
      await writePrivate(secretsFile, next);
      secretsCache = next;
      return clone(next);
    });
  }

  async function getPending() {
    await queue;
    if (!pendingCache) pendingCache = await readJson(pendingFile, {});
    return clone(pendingCache);
  }

  function savePending(value) {
    return enqueue(async () => {
      await writePrivate(pendingFile, value);
      pendingCache = clone(value);
    });
  }

  /** Atomic read-modify-write so two runs cannot lose each other's approvals. */
  function updatePending(mutator) {
    return enqueue(async () => {
      if (!pendingCache) pendingCache = await readJson(pendingFile, {});
      const next = clone(pendingCache);
      await mutator(next);
      await writePrivate(pendingFile, next);
      pendingCache = next;
      return clone(next);
    });
  }

  async function reset(seed) {
    const safe = validateState(seed);
    await enqueue(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writePrivate(stateFile, safe);
      await writePrivate(secretsFile, {});
      await writePrivate(pendingFile, {});
      cachedState = safe;
      secretsCache = {};
      pendingCache = {};
      loaded = true;
      return clone(cachedState);
    });
    return clone(safe);
  }

  async function exportBackup() {
    const state = await getState();
    return {
      kind: "agent-factory-workspace",
      version: 3,
      exportedAt: new Date().toISOString(),
      state,
    };
  }

  /** Remove the whole data directory (used only by the test harness). */
  async function destroy() {
    await queue;
    loaded = false;
    cachedState = undefined;
    secretsCache = undefined;
    pendingCache = undefined;
    await rm(dataDir, { recursive: true, force: true });
  }

  return {
    dataDir,
    stateFile,
    secretsFile,
    pendingFile,
    init: ensureLoaded,
    getState,
    replaceState,
    updateState,
    getSecrets,
    saveSecrets,
    updateSecrets,
    getPending,
    savePending,
    updatePending,
    reset,
    exportBackup,
    destroy,
  };
}
