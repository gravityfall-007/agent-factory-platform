/**
 * Multi-workspace manager.
 *
 * Each company workspace has its own data directory, store, and workflow
 * engine. A small registry lists workspaces and the default one. The active
 * workspace is selected per request with the X-Workspace-Id header (or a
 * ?workspace= query on SSE URLs).
 */
import { mkdir, readFile, writeFile, rename, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "./store.mjs";
import { createWorkflowEngine } from "./workflow.mjs";
import { DEFAULT_BRANCHES, HttpError, boundedString, stringArray } from "./core.mjs";

const REGISTRY_VERSION = 1;
const DEFAULT_WORKSPACE_NAME = "Northstar Labs";

const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "workspace";

function metaOf(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid workspace entry at ${index}`);
  const id = boundedString(value.id, `workspaces[${index}].id`, 80, true);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid workspace id: ${id}`);
  return {
    id,
    name: boundedString(value.name, `workspaces[${index}].name`, 80, true),
    company: boundedString(value.company, `workspaces[${index}].company`, 80, true),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

export function createWorkspaceManager({
  dataRoot,
  seedFile,
  gateway,
  connectorValidator,
  config,
  logger = console,
}) {
  const registryFile = path.join(dataRoot, "workspaces.json");
  const workspacesRoot = path.join(dataRoot, "workspaces");
  const cache = new Map();
  let registry = null;

  async function writeRegistry(next) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temp = `${registryFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, registryFile);
    registry = next;
  }

  function normalizeRegistry(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workspace registry must be an object.");
    if (!Array.isArray(raw.workspaces) || !raw.workspaces.length) throw new Error("Workspace registry has no workspaces.");
    const workspaces = raw.workspaces.map(metaOf);
    if (new Set(workspaces.map((item) => item.id)).size !== workspaces.length) throw new Error("Workspace IDs must be unique.");
    const defaultId = workspaces.some((item) => item.id === raw.defaultId) ? raw.defaultId : workspaces[0].id;
    return { version: REGISTRY_VERSION, defaultId, workspaces };
  }

  async function makeDefaultFromLegacyOrSeed() {
    const legacyState = path.join(dataRoot, "workspace.json");
    const id = "northstar";
    const dir = path.join(workspacesRoot, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let copied = false;
    try {
      await copyFile(legacyState, path.join(dir, "workspace.json"));
      copied = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (copied) {
      for (const name of ["connector-secrets.json", "pending-approvals.json"]) {
        try {
          await copyFile(path.join(dataRoot, name), path.join(dir, name));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }

    let name = DEFAULT_WORKSPACE_NAME;
    let company = DEFAULT_WORKSPACE_NAME;
    if (copied) {
      try {
        const state = JSON.parse(await readFile(legacyState, "utf8"));
        if (typeof state.company === "string" && state.company.trim()) company = state.company.trim();
        else if (typeof state.workspaceName === "string" && state.workspaceName.trim()) name = state.workspaceName.trim();
      } catch {
        /* the store will report a corrupt legacy file with a clear message */
      }
    }
    const now = new Date().toISOString();
    const meta = { id, name, company, createdAt: now, updatedAt: now };
    await writeRegistry({ version: REGISTRY_VERSION, defaultId: id, workspaces: [meta] });
    return meta;
  }

  async function init() {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(registryFile, "utf8"));
      registry = normalizeRegistry(raw);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await makeDefaultFromLegacyOrSeed();
  }

  function publicList() {
    return {
      workspaces: registry.workspaces.map((item) => ({ ...item })),
      defaultId: registry.defaultId,
    };
  }

  function metaFor(id) {
    return registry.workspaces.find((item) => item.id === id) || null;
  }

  async function get(id) {
    const meta = metaFor(String(id || ""));
    if (!meta) throw new HttpError(404, "Workspace not found.");
    if (cache.has(meta.id)) return cache.get(meta.id);
    const record = (async () => {
      const dataDir = path.join(workspacesRoot, meta.id);
      const store = createStore({ dataDir, seedFile });
      await store.init();
      const engine = createWorkflowEngine({ store, gateway, config, connectorValidator, logger });
      await engine.hydrate();
      return { id: meta.id, meta: { ...meta }, store, engine, dataDir };
    })();
    cache.set(meta.id, record);
    try {
      return await record;
    } catch (error) {
      cache.delete(meta.id);
      throw error;
    }
  }

  async function create({ name, company, executiveName, executiveRole, operatorName, operatorRole, branches }) {
    const companyValue = boundedString(company, "company", 80, true);
    const nameValue = boundedString(name || companyValue, "name", 80, true);
    const executiveNameValue = boundedString(executiveName || "Executive agent", "executiveName", 80, true);
    const executiveRoleValue = boundedString(executiveRole || "Executive agent · CEO", "executiveRole", 120, true);
    const branchList = [...new Set(stringArray(branches || DEFAULT_BRANCHES, "branches", 40, 80).filter(Boolean))];
    if (!branchList.length) throw new HttpError(400, "Add at least one branch.");

    let id = slugify(companyValue);
    if (metaFor(id)) id = `${id}-${randomUUID().slice(0, 4)}`;
    while (metaFor(id)) id = `${slugify(companyValue)}-${randomUUID().slice(0, 6)}`;

    const seed = JSON.parse(await readFile(seedFile, "utf8"));
    const now = new Date().toISOString();
    const state = {
      ...seed,
      operator: {
        name: operatorName ? boundedString(operatorName, "operatorName", 80, true) : seed.operator?.name || "Jordan Davis",
        role: operatorRole ? boundedString(operatorRole, "operatorRole", 120, true) : seed.operator?.role || "Workspace admin",
      },
      branches: branchList,
      executive: {
        ...seed.executive,
        name: executiveNameValue,
        role: executiveRoleValue,
        branch: "Executive",
        status: "active",
      },
      agents: [],
      approvals: [],
      activities: [
        {
          id: `evt_${randomUUID()}`,
          kind: "tool",
          icon: "✦",
          agent: operatorName || seed.operator?.name || "Workspace",
          action: "created a new workspace for",
          target: companyValue,
          detail: "New company workspace · add employees and tool grants to begin",
          time: "just now",
        },
      ],
      tasks: [],
      connectors: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const dataDir = path.join(workspacesRoot, id);
    const store = createStore({ dataDir, seedFile });
    await store.replaceState(state);
    const meta = { id, name: nameValue, company: companyValue, createdAt: now, updatedAt: now };
    await writeRegistry({ ...registry, workspaces: [...registry.workspaces, meta] });
    return meta;
  }

  async function update(id, { name, company }) {
    const meta = metaFor(String(id));
    if (!meta) throw new HttpError(404, "Workspace not found.");
    const next = {
      ...meta,
      name: name === undefined ? meta.name : boundedString(name, "name", 80, true),
      company: company === undefined ? meta.company : boundedString(company, "company", 80, true),
      updatedAt: new Date().toISOString(),
    };
    await writeRegistry({ ...registry, workspaces: registry.workspaces.map((item) => (item.id === meta.id ? next : item)) });
    const ctx = cache.get(meta.id);
    if (ctx) {
      const resolved = await ctx;
      resolved.meta = { ...next };
    }
    return { ...next };
  }

  async function remove(id) {
    const meta = metaFor(String(id));
    if (!meta) throw new HttpError(404, "Workspace not found.");
    if (registry.workspaces.length <= 1) throw new HttpError(409, "Keep at least one workspace.");
    const ctx = await get(meta.id);
    if (ctx.engine.activeRuns().length) throw new HttpError(409, "Cancel active runs in this workspace before deleting it.");
    await ctx.store.getState();
    ctx.engine.shutdown();
    cache.delete(meta.id);
    await rm(path.join(workspacesRoot, meta.id), { recursive: true, force: true });
    const remaining = registry.workspaces.filter((item) => item.id !== meta.id);
    const defaultId = registry.defaultId === meta.id ? remaining[0].id : registry.defaultId;
    await writeRegistry({ ...registry, defaultId, workspaces: remaining });
    return publicList();
  }

  function closeAll() {
    for (const record of cache.values()) {
      record.then((ctx) => ctx.engine.shutdown()).catch(() => {});
    }
  }

  async function ensureWorkspaceDirectories() {
    for (const meta of registry.workspaces) {
      await mkdir(path.join(workspacesRoot, meta.id), { recursive: true, mode: 0o700 });
    }
  }

  return {
    init,
    get,
    list: publicList,
    create,
    update,
    remove,
    closeAll,
    ensureWorkspaceDirectories,
    get defaultId() {
      return registry.defaultId;
    },
    get registryFile() {
      return registryFile;
    },
    get workspacesRoot() {
      return workspacesRoot;
    },
  };
}
