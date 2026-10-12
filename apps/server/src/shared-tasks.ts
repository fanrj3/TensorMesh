import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SharedTaskEntry, SharedTaskRegistryFile } from "@tensormesh/shared";

/**
 * Registry of "shared" (borrowed) tasks.
 *
 * A shared task is an admin-run task that executes in parallel on a GPU that is
 * already allocated to someone else's Slurm job. It runs OUTSIDE Slurm in a
 * root-owned systemd scope (created by `tmesh share` via `sudo systemd-run
 * --scope`), so it never cancels or conflicts with the original task.
 *
 * TensorMesh hides shared tasks from the status display: nvidia.ts filters out
 * any GPU process whose cgroup belongs to a registered scope, so the web/TUI/
 * status keep showing only the original user's task.
 *
 * The registry is persisted at /var/run/tensormesh/shared-tasks.json so it
 * survives server restarts. Stale entries (whose systemd scope no longer
 * exists) are pruned automatically on each status collection.
 */

const REGISTRY_PATH =
  process.env.TENSORMESH_SHARED_TASKS_FILE ?? "/var/run/tensormesh/shared-tasks.json";

const CGROUP_V2_ROOT = "/sys/fs/cgroup/unified";
const SYSTEM_SLICE = "system.slice";

interface LoadedRegistry {
  tasks: SharedTaskEntry[];
}

let registry: LoadedRegistry | null = null;

function registryFilePath(): string {
  return REGISTRY_PATH;
}

function loadRegistry(): LoadedRegistry {
  if (registry) return registry;
  try {
    const raw = readFileSync(registryFilePath(), "utf8");
    const parsed = JSON.parse(raw) as SharedTaskRegistryFile;
    registry = { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    registry = { tasks: [] };
  }
  return registry;
}

function persistRegistry(): void {
  const payload: SharedTaskRegistryFile = { version: 1, tasks: loadRegistry().tasks };
  try {
    mkdirSync(path.dirname(registryFilePath()), { recursive: true, mode: 0o700 });
    writeFileSync(registryFilePath(), `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600
    });
  } catch {
    // Registry file is best-effort state; the in-memory copy still works.
  }
}

function scopeCgroupPath(scope: string): string {
  const unit = scope.endsWith(".scope") ? scope : `${scope}.scope`;
  return path.join(CGROUP_V2_ROOT, SYSTEM_SLICE, unit);
}

/** A scope is alive if its systemd scope directory still exists in the unified hierarchy. */
function scopeExists(scope: string): boolean {
  return existsSync(scopeCgroupPath(scope));
}

/** Remove registry entries whose systemd scope no longer exists. */
function pruneStale(): void {
  if (process.env.TENSORMESH_SHARED_TASKS_SKIP_PRUNE === "1") return;
  const current = loadRegistry();
  const alive = current.tasks.filter((entry) => scopeExists(entry.scope));
  if (alive.length !== current.tasks.length) {
    registry = { tasks: alive };
    persistRegistry();
  }
}

export function registerSharedTask(entry: SharedTaskEntry): SharedTaskEntry {
  const current = loadRegistry();
  current.tasks = current.tasks.filter((task) => task.id !== entry.id);
  current.tasks.push(entry);
  registry = current;
  persistRegistry();
  return entry;
}

export function unregisterSharedTask(id: string): boolean {
  const current = loadRegistry();
  const before = current.tasks.length;
  current.tasks = current.tasks.filter((task) => task.id !== id);
  registry = current;
  persistRegistry();
  return current.tasks.length !== before;
}

export function listSharedTasks(): SharedTaskEntry[] {
  pruneStale();
  return loadRegistry().tasks.map((task) => ({ ...task }));
}

function readProcessCgroup(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return "";
  }
}

/**
 * True if the process lives inside one of the registered shared scopes.
 * Shared scopes are root systemd scopes under /system.slice/<scope>.
 */
export function isSharedProcess(pid: number, tasks?: SharedTaskEntry[]): boolean {
  const entries = tasks ?? loadRegistry().tasks;
  if (entries.length === 0) return false;
  const cgroup = readProcessCgroup(pid);
  if (!cgroup) return false;
  for (const entry of entries) {
    const unit = entry.scope.endsWith(".scope") ? entry.scope : `${entry.scope}.scope`;
    if (cgroup.includes(`/${SYSTEM_SLICE}/${unit}`)) return true;
  }
  return false;
}

export function resetSharedTaskRegistryForTests(): void {
  registry = null;
}

/** Mark shared tasks stale for tests (scope dirs rarely exist in CI). */
export function __pruneNow(): void {
  pruneStale();
}
