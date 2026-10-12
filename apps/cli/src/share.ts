#!/usr/bin/env node
/**
 * tmesh share — run an admin task in parallel on a GPU that is already
 * allocated to someone else's Slurm job, WITHOUT cancelling the original task.
 *
 * The task runs OUTSIDE Slurm in a root-owned systemd scope
 * (`systemd-run --scope`), so the original user's job keeps running.
 * TensorMesh hides the shared task from the status display: the server filters
 * out any GPU process whose cgroup belongs to a registered scope, so status
 * keeps showing only the original user's task.
 *
 * PERMISSION MODEL: `tmesh share` requires root. Run it through sudo, e.g.
 *
 *   sudo tmesh share --gpu-indexes 0,1 -- COMMAND...
 *
 * The sudo policy (sudoers / PAM) decides who may run it; TensorMesh itself
 * only verifies the process is running as root (uid 0). Non-root invocations
 * are rejected with a hint to use sudo.
 *
 * Usage:
 *   sudo tmesh share --gpu-indexes 0,1 [opts] -- COMMAND...
 *   sudo tmesh share --list
 *   sudo tmesh share --cancel ID
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { SharedTaskEntry } from "@tensormesh/shared";
import { createWebToken, getCurrentUser, shellQuote } from "@tensormesh/shared/node";

const apiBase = process.env.TENSORMESH_API ?? "http://localhost:4317";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

function color(text: string, name: keyof typeof colors): string {
  if (!process.stdout.isTTY) return text;
  return `${colors[name]}${text}${colors.reset}`;
}

async function cliToken(): Promise<string> {
  return createWebToken({ user: getCurrentUser(), ttlSeconds: 60 * 60 });
}

async function apiJson<T>(pathName: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await cliToken()}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiBase}${pathName}`, { ...init, headers });
  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | T
    | null;
  if (!response.ok) {
    throw new Error(
      (payload && typeof payload === "object" && "message" in payload
        ? payload.message
        : undefined) ?? `API returned ${response.status}`
    );
  }
  return payload as T;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** tmesh share requires root; the sudo policy decides who may use it. */
function requireRoot(): void {
  if (!isRoot()) {
    throw new Error(
      "tmesh share requires root. Run it through sudo:\n\n" +
        "  sudo tmesh share --gpu-indexes 0,1 -- COMMAND...\n\n" +
        "The sudo policy (sudoers) decides who may run this command."
    );
  }
}

function parseGpuIndexes(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const indexes = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite);
  return indexes.length > 0 ? indexes : undefined;
}

function parseArgs(args: string[]): {
  options: string[];
  command: string[];
} {
  const separator = args.indexOf("--");
  if (separator === -1) return { options: args, command: [] };
  return { options: args.slice(0, separator), command: args.slice(separator + 1) };
}

function getFlag(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printSharedTasksHelp(): void {
  process.stdout.write(`TensorMesh share (admin parallel GPU sharing)

Run a task in parallel on a GPU that is already allocated to someone else's
Slurm job. The original task is NOT cancelled; the shared task runs outside
Slurm in a root-owned systemd scope. TensorMesh hides the shared task from the
status display, so the card keeps showing the original user's task.

This command requires root. Run it through sudo; the sudo policy (sudoers)
decides who may use it.

Usage:
  sudo tmesh share --gpu-indexes 0,1 [opts] -- COMMAND...
      Run COMMAND in parallel on the given physical GPUs (can be occupied).
  sudo tmesh share --list
      List currently active shared tasks.
  sudo tmesh share --cancel ID
      Stop a shared task's systemd scope and remove it from the registry.

Options:
  --gpu-indexes 0,1             Physical GPUs to share (required)
  --gpu 2                       Alias for --gpu-indexes 2
  --name NAME                   Task name, defaults to tmesh-share
  --reason TEXT                 Human-readable description for --list
  --cwd DIR                     Working directory, defaults to current directory
  --memory 8G                   Optional systemd MemoryMax cap (e.g. 8G, 4096M)
  --cpu-quota 50%               Optional systemd CPUQuota cap (e.g. 50%, 200%)
  --output PATH                 Write task stdout/stderr to PATH
                                (defaults to <cwd>/.tmesh/shared/<id>.log)

Environment:
  TENSORMESH_API                API base URL, defaults to http://localhost:4317
`);
}

function uniqueScopeName(prefix: string): { id: string; scope: string } {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const id = `${prefix}-${stamp}`;
  return { id, scope: `shared-${id}.scope` };
}

export async function runSharedTask(args: string[]): Promise<void> {
  const { options, command } = parseArgs(args);
  if (hasFlag(options, "--help") || hasFlag(options, "-h")) {
    printSharedTasksHelp();
    return;
  }
  requireRoot();

  const gpuIndexes = parseGpuIndexes(
    getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu")
  );
  if (!gpuIndexes || gpuIndexes.length === 0) {
    throw new Error("--gpu-indexes is required (e.g. --gpu-indexes 6,7)");
  }
  if (command.length === 0) {
    throw new Error("Command is required after --");
  }
  const cwd = getFlag(options, "--cwd", process.cwd()) ?? process.cwd();
  const name = getFlag(options, "--name", "tmesh-share") ?? "tmesh-share";
  const reason = getFlag(options, "--reason");
  const memory = getFlag(options, "--memory");
  const cpuQuota = getFlag(options, "--cpu-quota");
  const outputArg = getFlag(options, "--output");

  const { id, scope } = uniqueScopeName(name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32));
  const commandLine = shellQuote(command);
  const logPath = outputArg
    ? path.resolve(cwd, outputArg)
    : path.join(cwd, ".tmesh", "shared", `${id}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });

  const systemdRunArgs = [
    "--scope",
    "--unit",
    scope
  ];
  if (memory) systemdRunArgs.push(`--property=MemoryMax=${memory}`);
  if (cpuQuota) systemdRunArgs.push(`--property=CPUQuota=${cpuQuota}`);
  // sudo (when used to reach root) resets the environment, so
  // CUDA_VISIBLE_DEVICES must be set by `env` inside the scope.
  systemdRunArgs.push(
    "--",
    "env",
    `CUDA_VISIBLE_DEVICES=${gpuIndexes.join(",")}`,
    "bash",
    "-lc",
    commandLine
  );

  process.stdout.write(
    `Sharing GPU ${gpuIndexes.join(",")} for "${name}" ` +
      `${reason ? `(${reason}) ` : ""}in scope ${scope}\n`
  );
  process.stdout.write(`Log: ${logPath}\n`);
  process.stdout.write(`GPU access via CUDA_VISIBLE_DEVICES=${gpuIndexes.join(",")}\n`);
  process.stdout.write(
    `The original task on those GPUs is untouched and stays visible; ` +
      `this shared task is hidden from TensorMesh status.\n\n`
  );

  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn("systemd-run", systemdRunArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const tee = (stream: NodeJS.ReadableStream | null, consoleName: "stdout" | "stderr") => {
    stream?.on("data", (chunk: Buffer) => {
      process[consoleName].write(chunk);
      logStream.write(chunk);
    });
  };
  tee(child.stdout, "stdout");
  tee(child.stderr, "stderr");

  let registered = false;
  try {
    await apiJson<{ ok: boolean }>("/api/shared-tasks", {
      method: "POST",
      body: JSON.stringify({
        id,
        gpuIndexes,
        scope,
        command: commandLine,
        startedAt: new Date().toISOString()
      })
    });
    registered = true;
  } catch (error) {
    process.stderr.write(
      `${color("warning:", "yellow")} could not register shared task with TensorMesh API ` +
        `(${error instanceof Error ? error.message : String(error)}); the task still runs.\n`
    );
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${color("error:", "red")} ${error.message}\n`);
      resolve(null);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`shared task terminated by ${signal}\n`);
      }
      resolve(code ?? null);
    });
  });

  logStream.end();
  if (registered) {
    await apiJson<{ ok: boolean }>(`/api/shared-tasks/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }).catch(() => undefined);
  }

  if (exitCode === 0) {
    process.stdout.write(`\nShared task ${id} finished successfully (exit 0).\n`);
  } else {
    process.stdout.write(
      `\nShared task ${id} finished with exit code ${exitCode ?? "unknown"}. ` +
        `Full log: ${logPath}\n`
    );
  }
}

export async function listSharedTasks(): Promise<void> {
  requireRoot();
  const { tasks } = await apiJson<{ tasks: SharedTaskEntry[] }>("/api/shared-tasks");
  if (tasks.length === 0) {
    process.stdout.write("No active shared tasks.\n");
    return;
  }
  process.stdout.write(`${color("Active shared tasks (hidden from status):", "bold")}\n`);
  for (const task of tasks) {
    process.stdout.write(
      `  ${color(task.id, "cyan")}  gpu=[${task.gpuIndexes.join(",")}]  ` +
        `scope=${task.scope}  user=${task.user}\n` +
        `      command: ${task.command}\n` +
        `      started: ${task.startedAt}\n`
    );
  }
  process.stdout.write(
    `\nStop one with: ${color("sudo tmesh share --cancel <id>", "green")}\n`
  );
}

export async function cancelSharedTask(id: string): Promise<void> {
  requireRoot();
  const { tasks } = await apiJson<{ tasks: SharedTaskEntry[] }>("/api/shared-tasks");
  const task = tasks.find((entry) => entry.id === id);
  if (!task) {
    throw new Error(`No active shared task with id ${id} (use sudo tmesh share --list)`);
  }
  const code = await new Promise<number | null>((resolve) => {
    const stop = spawn("systemctl", ["stop", task.scope], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    stop.on("error", () => resolve(null));
    stop.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    stop.on("close", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    throw new Error(
      `systemctl stop ${task.scope} returned exit code ${code ?? "unknown"} ` +
        `(the scope may already be gone)`
    );
  }
  await apiJson<{ ok: boolean }>(`/api/shared-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  process.stdout.write(`Stopped shared task ${id} (scope ${task.scope}) and removed it.\n`);
}
