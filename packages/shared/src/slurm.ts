import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  getSlurmKillTiming,
  isActiveSlurmJobState,
  parseSlurmDurationSeconds,
  type SlurmJob,
  type SlurmNode,
  type SlurmStatus
} from "./index";

const execFileAsync = promisify(execFile);
const queueFormat = "%i|%j|%u|%T|%P|%N|%M|%l|%R|%k|%b";
const defaultSlurmTimeLimit = "7-00:00:00";
export const maxSlurmTimeLimitSeconds = 90 * 24 * 60 * 60;
const configuredDefaultCpusPerGpu = Number(process.env.TENSORMESH_DEFAULT_CPUS_PER_GPU ?? 4);
const defaultCpusPerGpu = Number.isInteger(configuredDefaultCpusPerGpu) && configuredDefaultCpusPerGpu > 0 ? configuredDefaultCpusPerGpu : 4;
const defaultMemPerGpu = process.env.TENSORMESH_DEFAULT_MEM_PER_GPU?.trim() || "24G";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const interactiveWrapper = path.join(repoRoot, "packages", "shared", "src", "slurm_interactive.py");
const cancelMarkerDir = process.env.TENSORMESH_CANCEL_MARKER_DIR ?? path.join(repoRoot, "tmp", "cancelled-jobs");
const srunCommand = process.env.TENSORMESH_SRUN?.trim() || "srun";
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
const tmuxSocketName = process.env.TENSORMESH_TMUX_SOCKET ?? `tensormesh-${currentUid ?? process.env.USER ?? "user"}`;
const tmuxSessionPrefix = "tmesh-";
const tmeshCommand = path.join(repoRoot, "bin", "tmesh");
const tmuxLogFilter = path.join(repoRoot, "packages", "shared", "src", "tmux_log_filter.py");
const tmuxCommandMode = path.join(repoRoot, "packages", "shared", "src", "tmux_command_mode.sh");
const tmuxCommandPrompt = path.join(repoRoot, "packages", "shared", "src", "tmux_command_prompt.py");

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface SlurmRunInput {
  gpus?: number;
  gpuIndexes?: number[];
  name?: string;
  time?: string;
  taskDescription?: string;
  notice?: boolean;
  slurmTime?: string;
  begin?: string;
  cwd?: string;
  partition?: string;
  cpusPerGpu?: number;
  memPerGpu?: string;
  output?: string;
  command: string[];
}

export interface SlurmRunResult {
  jobId: string;
  rawOutput: string;
  estimatedHours?: number;
  estimatedEndAt?: string;
  outputPath?: string;
}

export interface SlurmInteractiveInput extends Omit<SlurmRunInput, "command" | "output"> {
  command?: string[];
}

export interface TmeshTmuxSession {
  id: string;
  name: string;
  initialName?: string;
  shellPane?: string;
  owner?: string;
  slurmJobId?: string;
  attached: boolean;
  attachedClients: number;
  windows: number;
  createdAt?: string;
  lastActivityAt?: string;
  cwd?: string;
  jobName?: string;
  reason?: string;
  command?: string;
  releaseOnDetach: boolean;
  submitted: boolean;
}

export interface TmeshTmuxCloseResult {
  id: string;
  name: string;
  slurmJobId?: string;
  cancelledSlurmJob: boolean;
  cancelError?: string;
}

export interface TmeshTmuxReleaseResult {
  id: string;
  name: string;
  slurmJobId?: string;
  released: boolean;
  cancelledSlurmJob: boolean;
  cancelError?: string;
  reason?: string;
}

export interface TmeshTmuxAccess {
  socketName?: string;
  socketPath?: string;
}

export interface TmeshTmuxPaneState {
  paneId?: string;
  active: boolean;
  inMode: boolean;
  dead: boolean;
  currentCommand?: string;
  cursorX?: number;
  cursorY?: number;
  windowZoomed: boolean;
}

export interface TmeshTmuxSessionSnapshot {
  session: TmeshTmuxSession;
  targetPane: string;
  capturedAt: string;
  pane: TmeshTmuxPaneState;
  screen: string;
  logPath?: string;
  logTail?: string;
}

export interface TmeshTmuxSendInputResult {
  id: string;
  name: string;
  targetPane: string;
  sent: boolean;
  inputLength: number;
  enter: boolean;
}

export interface NvidiaSmiResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LiveGpuRow {
  index: number;
  name: string;
  memory: string;
  util: string;
  user: string;
  task: string;
  state: string;
}

interface GpuProcess {
  gpuUuid: string;
  pid: string;
  processName: string;
  usedMemoryMb: number;
  user?: string;
  command?: string;
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "(null)" && trimmed !== "N/A" ? trimmed : undefined;
}

function normalizeSlurmTimestamp(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || /^(Unknown|None|N\/A)$/i.test(cleaned)) return undefined;
  const timestamp = new Date(cleaned).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isReadOnlyNvidiaSmiArg(arg: string): boolean {
  return arg === "-L" ||
    arg === "-q" ||
    arg === "-h" ||
    arg === "--help" ||
    arg === "--list-gpus" ||
    arg === "--query" ||
    arg === "--query-gpu" ||
    arg.startsWith("--query-gpu=") ||
    arg === "--query-compute-apps" ||
    arg.startsWith("--query-compute-apps=") ||
    arg === "--query-accounted-apps" ||
    arg.startsWith("--query-accounted-apps=") ||
    arg === "--query-retired-pages" ||
    arg.startsWith("--query-retired-pages=") ||
    arg === "--format" ||
    arg.startsWith("--format=") ||
    arg === "-i" ||
    arg.startsWith("-i=") ||
    arg === "--id" ||
    arg.startsWith("--id=") ||
    arg === "--display" ||
    arg.startsWith("--display=");
}

function validateReadOnlyNvidiaSmiArgs(args: string[]): void {
  if (args.length > 32) throw new Error("too many nvidia-smi arguments");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg.includes("\0")) throw new Error("invalid nvidia-smi argument");
    if (!arg.startsWith("-")) continue;
    if (!isReadOnlyNvidiaSmiArg(arg)) {
      throw new Error(`nvidia-smi argument "${arg}" is not allowed through TensorMesh`);
    }
  }
}

export async function runNvidiaSmi(args: string[] = []): Promise<NvidiaSmiResult> {
  validateReadOnlyNvidiaSmiArgs(args);
  return new Promise((resolve) => {
    const child = spawn("nvidia-smi", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 4 * 1024 * 1024;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdoutChunks.push(chunk);
      else child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderrChunks.push(chunk);
      else child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      resolve({
        command: ["nvidia-smi", ...args],
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 127
      });
    });
    child.on("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        command: ["nvidia-smi", ...args],
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: signal ? `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}terminated by ${signal}\n` : stderr,
        exitCode: code ?? (signal ? 124 : 1)
      });
    });
  });
}

export function parseEstimatedHours(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;

  const decimalHours = Number(normalized);
  if (Number.isFinite(decimalHours) && decimalHours > 0) {
    return decimalHours;
  }

  const hms = normalized.match(/^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) {
    const days = Number(hms[1] ?? 0);
    const hours = Number(hms[2]);
    const minutes = Number(hms[3]);
    const seconds = Number(hms[4] ?? 0);
    const total = days * 24 + hours + minutes / 60 + seconds / 3600;
    return total > 0 ? total : undefined;
  }

  throw new Error("--time must be a positive hour value, for example 0.5, 2, or 10");
}

export function validateSlurmTimeLimit(value: string): number {
  const seconds = parseSlurmDurationSeconds(value);
  if (seconds === undefined || seconds <= 0) {
    throw new Error("--slurm-time must be a positive Slurm duration, for example 02:00:00 or 31-00:00:00");
  }
  if (seconds > maxSlurmTimeLimitSeconds) {
    throw new Error("--slurm-time cannot exceed the gpu partition maximum of 90 days");
  }
  return seconds;
}

function estimateBaseDate(begin: string | undefined): Date {
  if (!begin) return new Date();
  const parsed = new Date(begin);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function estimateEndAt(hours: number | undefined, base = new Date()): string | undefined {
  if (!hours) return undefined;
  return new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function formatEstimatedHours(hours: number | undefined): string | undefined {
  if (!hours) return undefined;
  if (hours < 1 / 60) return `${Math.max(1, Math.round(hours * 3600))}s`;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${hours.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}h`;
}

export function formatEstimatedEnd(endAt: string | undefined): string | undefined {
  if (!endAt) return undefined;
  const date = new Date(endAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}年${month}月${day}日${hour}时${minute}分`;
}

interface TmeshComment {
  tmesh?: {
    estimatedHours?: number;
    estimatedEndAt?: string;
    description?: string;
    descriptionB64?: string;
    notice?: boolean;
  };
}

function normalizeTaskDescription(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? trimmed.slice(0, 240) : trimmed;
}

function encodeTaskDescription(value: string | undefined): string | undefined {
  const normalized = normalizeTaskDescription(value);
  return normalized ? Buffer.from(normalized, "utf8").toString("base64url") : undefined;
}

function decodeTaskDescription(tmesh: TmeshComment["tmesh"]): string | undefined {
  if (tmesh?.descriptionB64) {
    try {
      return normalizeTaskDescription(Buffer.from(tmesh.descriptionB64, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return normalizeTaskDescription(tmesh?.description);
}

function encodeComment(
  estimatedHours: number | undefined,
  estimatedEndAt: string | undefined,
  notice: boolean | undefined,
  taskDescription: string | undefined
): string | undefined {
  const descriptionB64 = encodeTaskDescription(taskDescription);
  if (!estimatedHours && !estimatedEndAt && !notice && !descriptionB64) return undefined;
  return `tmesh:${JSON.stringify({ estimatedHours, estimatedEndAt, notice: Boolean(notice), descriptionB64 })}`;
}

function decodeComment(comment: string | undefined): TmeshComment {
  const cleaned = clean(comment);
  if (!cleaned?.startsWith("tmesh:")) return {};
  try {
    const parsed = JSON.parse(cleaned.slice("tmesh:".length)) as TmeshComment["tmesh"];
    return { tmesh: parsed };
  } catch {
    return {};
  }
}

function attachEstimate(job: SlurmJob): SlurmJob {
  const decoded = decodeComment(job.comment);
  const estimatedHours = decoded.tmesh?.estimatedHours;
  const estimatedEndAt = decoded.tmesh?.estimatedEndAt;
  const taskDescription = decodeTaskDescription(decoded.tmesh);
  const notice = Boolean(decoded.tmesh?.notice);
  const estimatedTime = estimatedEndAt ? new Date(estimatedEndAt).getTime() : Number.NaN;
  const active = isActiveSlurmJobState(job.state);
  const killTiming = getSlurmKillTiming(job);
  return {
    ...job,
    ...killTiming,
    reason: taskDescription ?? job.reason,
    slurmReason: job.reason,
    taskDescription,
    notice,
    estimatedHours,
    estimatedEndAt,
    estimatedOverdue: active && Number.isFinite(estimatedTime) && Date.now() > estimatedTime
  };
}

function splitPiped(line: string): string[] {
  return line.split("|").map((part) => part.trim());
}

async function runSlurmCommand(command: string, args: string[], options: { stdin?: string; cwd?: string } = {}): Promise<CommandResult> {
  if (options.stdin === undefined) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`Slurm command not found: ${command}. Install Slurm client tools first.`);
      }
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Slurm command not found: ${command}. Install Slurm client tools first.`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(options.stdin);
  });
}

function parseSqueue(output: string): SlurmJob[] {
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => splitPiped(line))
    .filter((columns) => columns.length >= 9)
    .map(([id, name, user, state, partition, nodes, elapsed, timeLimit, reason, comment, gres]) => attachEstimate({
      id,
      name,
      user,
      state,
      partition,
      nodes,
      elapsed,
      timeLimit,
      reason,
      comment: clean(comment),
      allocatedGpuIndexes: parseAllocatedGpuIndexes(gres ?? ""),
      gres: clean(gres)
    }));
}

function parseSinfo(output: string): SlurmNode[] {
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => splitPiped(line))
    .filter((columns) => columns.length >= 6)
    .map(([name, state, cpus, memoryMb, gres, reason]) => ({
      name,
      state,
      cpus: Number.isFinite(Number(cpus)) ? Number(cpus) : undefined,
      memoryMb: Number.isFinite(Number(memoryMb)) ? Number(memoryMb) : undefined,
      gres: clean(gres),
      reason: clean(reason)
    }));
}

function parseScontrolKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const match of output.matchAll(/(\S+?)=([^\s]*)/g)) {
    result[match[1]] = match[2];
  }

  return result;
}

function addGpuIndexSpec(indexes: Set<number>, spec: string): void {
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isInteger(start) && Number.isInteger(end)) {
        for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
          indexes.add(index);
        }
      }
      continue;
    }

    const index = Number(trimmed);
    if (Number.isInteger(index) && index >= 0) indexes.add(index);
  }
}

function parseAllocatedGpuIndexes(output: string): number[] | undefined {
  const indexes = new Set<number>();

  for (const match of output.matchAll(/IDX:([0-9,-]+)/g)) {
    addGpuIndexSpec(indexes, match[1]);
  }

  for (const match of output.matchAll(/(?:^|[,\s=/])(?:gres[:/])?gpu:gpu(\d+)(?::\d+|=\d+)?/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 0) indexes.add(index);
  }

  return indexes.size > 0 ? Array.from(indexes).sort((a, b) => a - b) : undefined;
}

function buildGres(input: SlurmRunInput): string {
  if (input.gpuIndexes && input.gpuIndexes.length > 0) {
    return input.gpuIndexes.map((index) => `gpu:gpu${index}:1`).join(",");
  }

  return `gpu:${input.gpus}`;
}

function requestedGpuCount(input: Pick<SlurmRunInput, "gpus" | "gpuIndexes">): number {
  return input.gpuIndexes?.length || input.gpus || 0;
}

function formatScaledNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeSlurmMemoryUnit(unit: string | undefined): string {
  if (!unit) return "";
  const upper = unit.toUpperCase();
  if (/^[KMGTP]B$/.test(upper)) return upper.slice(0, 1);
  return upper;
}

function scaleSlurmMemory(memory: string, multiplier: number): string {
  const trimmed = memory.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([KMGTP]?B?)?$/i);
  if (!match) {
    throw new Error("--mem-per-gpu must be a numeric Slurm memory value, for example 24G or 32768M");
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("--mem-per-gpu must be greater than 0");
  }

  return `${formatScaledNumber(amount * multiplier)}${normalizeSlurmMemoryUnit(match[2])}`;
}

function gpuResourceArgs(input: Pick<SlurmRunInput, "gpus" | "gpuIndexes" | "cpusPerGpu" | "memPerGpu">): string[] {
  const gpuCount = requestedGpuCount(input);
  const args: string[] = [];

  // Slurm 19.05 can serialize same-node typed GPU jobs when per-GPU CPU/mem flags are used.
  // TensorMesh keeps the per-GPU user model and submits equivalent single-task totals.
  if (input.cpusPerGpu) {
    const cpus = input.cpusPerGpu * gpuCount;
    if (!Number.isInteger(cpus) || cpus <= 0) {
      throw new Error("--cpus-per-gpu must produce a positive integer CPU count");
    }
    args.push(`--cpus-per-task=${cpus}`);
  }

  if (input.memPerGpu) {
    args.push(`--mem=${scaleSlurmMemory(input.memPerGpu, gpuCount)}`);
  }

  return args;
}

export function shellQuote(args: string[]): string {
  return args
    .map((arg) => {
      if (/^[A-Za-z0-9_./:=,+@%-]+$/.test(arg)) return arg;
      return `'${arg.replaceAll("'", "'\\''")}'`;
    })
    .join(" ");
}

export function getCurrentUser(): string {
  return process.env.USER || process.env.LOGNAME || os.userInfo().username || "unknown";
}

export async function getSlurmJobs(options: { all?: boolean; user?: string } = {}): Promise<SlurmJob[]> {
  const args = [
    "--noheader",
    `--format=${queueFormat}`
  ];

  if (!options.all) {
    args.push("--user", options.user ?? getCurrentUser());
  }

  const { stdout } = await runSlurmCommand("squeue", args);
  return parseSqueue(stdout);
}

export async function getSlurmNodes(): Promise<SlurmNode[]> {
  const { stdout } = await runSlurmCommand("sinfo", ["--noheader", "--Node", "--format=%N|%T|%c|%m|%G|%E"]);
  return parseSinfo(stdout);
}

export async function getSlurmClusterName(): Promise<string | undefined> {
  const { stdout } = await runSlurmCommand("scontrol", ["show", "config"]);
  const match = stdout.match(/^ClusterName\s*=\s*(.+)$/m);
  return clean(match?.[1]);
}

export async function getSlurmStatus(options: { allJobs?: boolean; user?: string } = {}): Promise<SlurmStatus> {
  try {
    const [nodes, jobs, clusterName] = await Promise.all([
      getSlurmNodes(),
      getSlurmJobs({ all: options.allJobs, user: options.user }),
      getSlurmClusterName().catch(() => undefined)
    ]);

    return {
      available: true,
      checkedAt: new Date().toISOString(),
      clusterName,
      nodes,
      jobs
    };
  } catch (error) {
    return {
      available: false,
      checkedAt: new Date().toISOString(),
      nodes: [],
      jobs: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function queryGpuRows(): Promise<LiveGpuRow[]> {
  const { stdout } = await runSlurmCommand("nvidia-smi", [
    "--query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits"
  ]);

  if (!stdout) return [];

  const processes = await queryGpuProcesses().catch(() => []);
  const processesByUuid = new Map<string, GpuProcess[]>();
  for (const process of processes) {
    const existing = processesByUuid.get(process.gpuUuid) ?? [];
    existing.push(process);
    processesByUuid.set(process.gpuUuid, existing);
  }

  return stdout.split("\n").map((line) => {
    const [index, uuid, name, memoryUsed, memoryTotal, utilization] = line.split(",").map((part) => part.trim());
    const used = Number(memoryUsed);
    const total = Number(memoryTotal);
    const util = Number(utilization);
    const gpuProcesses = processesByUuid.get(uuid) ?? [];
    const active = gpuProcesses.length > 0 || used > 1024 || util > 0;
    const users = Array.from(new Set(gpuProcesses.map((process) => process.user).filter(Boolean)));
    const task = summarizeGpuProcesses(gpuProcesses);

    return {
      index: Number(index),
      name,
      memory: `${Math.round(used / 1024)} / ${Math.round(total / 1024)} GB`,
      util: `${Math.round(util)}%`,
      user: users.length > 0 ? users.join(",") : "-",
      task: task ?? (active ? "GPU memory in use" : "-"),
      state: active ? "running" : "idle"
    };
  });
}

async function queryGpuProcesses(): Promise<GpuProcess[]> {
  const { stdout } = await runSlurmCommand("nvidia-smi", [
    "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
    "--format=csv,noheader,nounits"
  ]);

  if (!stdout) return [];

  const processes = stdout
    .split("\n")
    .map((line) => {
      const [gpuUuid, pid, processName, usedMemory] = line.split(",").map((part) => part.trim());
      return {
        gpuUuid,
        pid,
        processName,
        usedMemoryMb: Number(usedMemory)
      };
    })
    .filter((process) => process.gpuUuid && process.pid);

  await attachProcessUsers(processes);
  return processes;
}

async function attachProcessUsers(processes: GpuProcess[]): Promise<void> {
  if (processes.length === 0) return;

  const pids = Array.from(new Set(processes.map((process) => process.pid)));
  const { stdout } = await runSlurmCommand("ps", ["-o", "pid=,user=,comm=", "-p", pids.join(",")]);
  const processInfo = new Map<string, { user: string; command: string }>();

  for (const line of stdout.split("\n")) {
    const [pid, user, command] = line.trim().split(/\s+/, 3);
    if (pid && user) {
      processInfo.set(pid, { user, command: command ?? "-" });
    }
  }

  for (const process of processes) {
    const info = processInfo.get(process.pid);
    if (info) {
      process.user = info.user;
      process.command = info.command;
    }
  }
}

function summarizeGpuProcesses(processes: GpuProcess[]): string | undefined {
  if (processes.length === 0) return undefined;
  if (processes.length === 1) {
    const [process] = processes;
    const command = process.command ?? path.basename(process.processName);
    const memory = Number.isFinite(process.usedMemoryMb) ? ` ${Math.round(process.usedMemoryMb / 1024)}GB` : "";
    return `${command} pid=${process.pid}${memory}`;
  }

  const users = Array.from(new Set(processes.map((process) => process.user).filter(Boolean)));
  const memory = processes.reduce((sum, process) => sum + (Number.isFinite(process.usedMemoryMb) ? process.usedMemoryMb : 0), 0);
  const memoryLabel = memory > 0 ? ` ${Math.round(memory / 1024)}GB` : "";
  return `${processes.length} GPU processes${users.length > 0 ? ` by ${users.join(",")}` : ""}${memoryLabel}`;
}

export async function getSlurmJob(jobId: string): Promise<SlurmJob> {
  const { stdout } = await runSlurmCommand("scontrol", ["show", "job", jobId, "--details"]);
  const values = parseScontrolKeyValues(stdout);

  return attachEstimate({
    id: values.JobId ?? jobId,
    name: values.JobName ?? "-",
    user: values.UserId?.split("(")[0] ?? "-",
    state: values.JobState ?? "-",
    partition: values.Partition ?? "-",
    nodes: values.NodeList ?? "-",
    elapsed: values.RunTime ?? "-",
    timeLimit: values.TimeLimit ?? "-",
    reason: values.Reason ?? "-",
    comment: clean(values.Comment),
    allocatedGpuIndexes: parseAllocatedGpuIndexes(stdout),
    tres: clean(values.AllocTRES ?? values.ReqTRES ?? values.TresPerJob ?? values.TRES),
    gres: clean(values.Gres ?? values.TresPerNode),
    workDir: clean(values.WorkDir),
    command: clean(values.Command),
    submittedAt: normalizeSlurmTimestamp(values.SubmitTime),
    startedAt: normalizeSlurmTimestamp(values.StartTime),
    endedAt: normalizeSlurmTimestamp(values.EndTime),
    exitCode: clean(values.ExitCode)
  });
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^0-9A-Za-z_.-]/g, "_");
}

export async function markSlurmJobSuppressed(jobId: string, reason = "cancelled"): Promise<void> {
  if (!jobId.trim()) return;
  await mkdir(cancelMarkerDir, { recursive: true });
  await writeFile(
    path.join(cancelMarkerDir, `${safeJobId(jobId)}.json`),
    `${JSON.stringify({ jobId, reason, markedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

export async function isSlurmJobSuppressed(jobId: string): Promise<boolean> {
  if (!jobId.trim()) return false;
  try {
    await readFile(path.join(cancelMarkerDir, `${safeJobId(jobId)}.json`), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function cancelSlurmJob(jobId: string): Promise<void> {
  await runSlurmCommand("scancel", [jobId]);
  await markSlurmJobSuppressed(jobId, "cancelled").catch(() => undefined);
}

function validateRunInput(input: SlurmRunInput): void {
  const hasGpuIndexes = Boolean(input.gpuIndexes?.length);

  if (hasGpuIndexes && input.gpus !== undefined && input.gpus !== input.gpuIndexes?.length) {
    throw new Error("--gpus must match --gpu-indexes count when both are provided");
  }
  if (hasGpuIndexes && input.gpuIndexes?.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new Error("--gpu-indexes must contain non-negative integers");
  }
  if (!hasGpuIndexes && (!Number.isInteger(input.gpus) || (input.gpus ?? 0) <= 0)) {
    throw new Error("--gpus must be a positive integer, or use --gpu-indexes");
  }
  if (input.cpusPerGpu !== undefined && (!Number.isInteger(input.cpusPerGpu) || input.cpusPerGpu <= 0)) {
    throw new Error("--cpus-per-gpu must be a positive integer");
  }
  if (input.memPerGpu !== undefined) {
    scaleSlurmMemory(input.memPerGpu, 1);
  }
  if (input.slurmTime !== undefined) {
    validateSlurmTimeLimit(input.slurmTime);
  }
  if (input.command.length === 0) {
    throw new Error("Command is required after --");
  }
}

function buildBatchScript(input: Required<Pick<SlurmRunInput, "command">>, managedLogBase?: string): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
  ];

  if (managedLogBase) {
    lines.push(
      "",
      `TMESH_JOB_LOG_DIR=${shellQuote([managedLogBase])}/"\${SLURM_JOB_ID}"`,
      "mkdir -p \"$TMESH_JOB_LOG_DIR\"",
      "exec > \"$TMESH_JOB_LOG_DIR/run.log\" 2>&1"
    );
  }

  lines.push("", "echo \"TensorMesh job ${SLURM_JOB_ID} on ${SLURMD_NODENAME:-unknown}\"", "echo \"CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-}\"", shellQuote(input.command));
  return `${lines.join("\n")}\n`;
}

function normalizeOutputPath(output: string, cwd: string): string {
  return path.isAbsolute(output) ? output : path.resolve(cwd, output);
}

function defaultRunLogTemplate(cwd: string): string {
  return path.join(cwd, ".tmesh", "%j", "run.log");
}

async function createInteractiveShellRc(baseDir?: string): Promise<{ tmpDir: string; rcPath: string }> {
  const tmpDir = baseDir ?? await mkdtemp(path.join(os.tmpdir(), "tmesh-bash-"));
  if (baseDir) await mkdir(tmpDir, { recursive: true });
  const rcPath = path.join(tmpDir, "bashrc");
  const content = [
    "# TensorMesh interactive shell rc",
    "if [ -r \"$HOME/.bashrc\" ]; then",
    "  . \"$HOME/.bashrc\"",
    "fi",
    "",
    "__tmesh_prompt_prefix() {",
    "  local job_id=\"${SLURM_JOB_ID:-?}\"",
    "  local raw=\"[T${job_id}]\"",
    "  case \"${PS1:-}\" in",
    "    *\"${raw}\"*) return ;;",
    "  esac",
    "  PS1=\"\\[\\033[1;36m\\]${raw}\\[\\033[0m\\] ${PS1:-\\\\u@\\\\h:\\\\w\\\\$ }\"",
    "}",
    "",
    "__tmesh_prompt_prefix",
    "set -o ignoreeof 2>/dev/null || true",
    "export IGNOREEOF=1000000",
    "if declare -p PROMPT_COMMAND >/dev/null 2>&1 && declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare \\-a'; then",
    "  PROMPT_COMMAND+=(__tmesh_prompt_prefix)",
    "elif [ -n \"${PROMPT_COMMAND:-}\" ]; then",
    "  PROMPT_COMMAND=\"${PROMPT_COMMAND}; __tmesh_prompt_prefix\"",
    "else",
    "  PROMPT_COMMAND=\"__tmesh_prompt_prefix\"",
    "fi",
    "",
    "__tmesh_detach_client_or_exit() {",
    "  local status=\"${1:-0}\"",
    "  if [ \"${TMESH_TMUX_RELEASE_ON_DETACH:-}\" = \"1\" ] && [ -n \"${TMESH_TMUX_SESSION:-}\" ] && [ -n \"${TMUX:-}\" ] && command -v tmux >/dev/null 2>&1; then",
    "    tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" detach-client >/dev/null 2>&1 && return \"$status\"",
    "    printf 'TensorMesh: failed to detach this client; use Ctrl-b d or tmesh close %s.\\n' \"${SLURM_JOB_ID:-$TMESH_TMUX_SESSION}\" >&2",
    "    return 1",
    "  fi",
    "  builtin exit \"$status\"",
    "}",
    "",
    "exit() {",
    "  __tmesh_detach_client_or_exit \"${1:-0}\"",
    "}",
    "",
    "logout() {",
    "  __tmesh_detach_client_or_exit \"${1:-0}\"",
    "}",
    ""
  ].join("\n");
  await writeFile(rcPath, content, "utf8");
  return { tmpDir, rcPath };
}

function tmuxJobPrelude(cwd?: string): string {
  const logBase = cwd ? shellQuote([path.join(cwd, ".tmesh")]) : "";
  const logSetup = cwd
    ? [
        `TMESH_JOB_LOG_DIR=${logBase}/"\${SLURM_JOB_ID}"`,
        "mkdir -p \"$TMESH_JOB_LOG_DIR\"",
        `if [ -n "\${TMESH_TMUX_SESSION:-}" ] && command -v tmux >/dev/null 2>&1; then target="\${TMESH_TMUX_SESSION}"; if tmux -L "\${TMESH_TMUX_SOCKET:-tensormesh}" has-session -t "tmesh-\${SLURM_JOB_ID}" 2>/dev/null; then target="tmesh-\${SLURM_JOB_ID}"; fi; tmux -L "\${TMESH_TMUX_SOCKET:-tensormesh}" set-option -t "$target" @tmesh_log "$TMESH_JOB_LOG_DIR/bash.log" >/dev/null 2>&1 || true; tmux -L "\${TMESH_TMUX_SOCKET:-tensormesh}" pipe-pane -o -t "$target" "/usr/bin/python3 ${shellQuote([tmuxLogFilter])} >> '$TMESH_JOB_LOG_DIR/bash.log'" >/dev/null 2>&1 || true; fi`,
        "echo \"Log: $TMESH_JOB_LOG_DIR/bash.log\""
      ]
    : [];
  return [
    "echo \"TensorMesh interactive job ${SLURM_JOB_ID}\"",
    "if [ -n \"${TMESH_TMUX_SESSION:-}\" ] && command -v tmux >/dev/null 2>&1; then target=\"$TMESH_TMUX_SESSION\"; renamed=\"tmesh-${SLURM_JOB_ID}\"; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" rename-session -t \"$target\" \"$renamed\" 2>/dev/null && target=\"$renamed\"; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" @tmesh_slurm_job \"$SLURM_JOB_ID\" >/dev/null 2>&1 || true; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" status-left-length 64 >/dev/null 2>&1 || true; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" status-right-length 72 >/dev/null 2>&1 || true; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" status-interval 10 >/dev/null 2>&1 || true; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" status-left \"#[bold] TensorMesh #[fg=colour117]T${SLURM_JOB_ID} #[default]\" >/dev/null 2>&1 || true; tmux -L \"${TMESH_TMUX_SOCKET:-tensormesh}\" set-option -t \"$target\" status-right \"#[bold]Kill in #(squeue --noheader --jobs=#{@tmesh_slurm_job} --format=%L 2>/dev/null) #[default] %H:%M\" >/dev/null 2>&1 || true; fi",
    ...logSetup,
    "tmesh job \"${SLURM_JOB_ID}\" || true"
  ].join("; ");
}

function buildInteractiveCommand(command: string[], cwd?: string): string[] {
  return [
    "bash",
    "-lc",
    `${tmuxJobPrelude(cwd)}; exec ${shellQuote(command)}`
  ];
}

function buildDefaultInteractiveCommand(rcPath: string, cwd?: string): string[] {
  return [
    "bash",
    "-lc",
    [
      tmuxJobPrelude(cwd),
      `exec bash --rcfile ${shellQuote([rcPath])} -i`
    ].join("; ")
  ];
}

function tmuxArgs(args: string[], access: TmeshTmuxAccess = {}): string[] {
  if (access.socketPath) return ["-S", access.socketPath, ...args];
  return ["-L", access.socketName ?? tmuxSocketName, ...args];
}

async function runTmuxCommand(args: string[], options: { cwd?: string; access?: TmeshTmuxAccess } = {}): Promise<CommandResult> {
  return runSlurmCommand("tmux", tmuxArgs(args, options.access), options);
}

function safeTmuxPart(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback).trim().replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function createTmuxSessionName(input: { name?: string }): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const nonce = Math.random().toString(36).slice(2, 6);
  return `${tmuxSessionPrefix}${timestamp}-${safeTmuxPart(input.name, "bash")}-${nonce}`;
}

function parseTmuxEpoch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function tmuxSessionIdFromName(name: string): string {
  return name.startsWith(tmuxSessionPrefix) ? name.slice(tmuxSessionPrefix.length) : name;
}

function tmuxSessionNameFromId(id: string): string {
  return id.startsWith(tmuxSessionPrefix) ? id : `${tmuxSessionPrefix}${id}`;
}

function getUserUid(user: string): number | undefined {
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith(`${user}:`));
    const uid = line?.split(":")[2];
    const parsed = Number(uid);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function getTmeshTmuxAccessForUser(user: string): TmeshTmuxAccess {
  if (process.env.TENSORMESH_TMUX_SOCKET_PATH?.trim()) return { socketPath: process.env.TENSORMESH_TMUX_SOCKET_PATH.trim() };
  const configuredSocketName = process.env.TENSORMESH_TMUX_SOCKET?.trim();
  const uid = getUserUid(user);
  if (uid !== undefined) return { socketPath: path.join(os.tmpdir(), `tmux-${uid}`, configuredSocketName || `tensormesh-${uid}`) };
  if (configuredSocketName) return { socketName: configuredSocketName };
  return { socketName: `tensormesh-${user}` };
}

function parseTensorMeshJobId(text: string): string | undefined {
  const match = text.match(/TensorMesh interactive job\s+(\d+)|srun: job\s+(\d+)|srun: Granted job allocation\s+(\d+)/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseTmuxBoolean(value: string | undefined): boolean {
  const normalized = clean(value)?.toLowerCase();
  return normalized === "1" || normalized === "yes" || normalized === "true" || normalized === "on";
}

function parseTmuxInteger(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function getTmeshTmuxAttachedClients(sessionName: string, access?: TmeshTmuxAccess): Promise<number> {
  const { stdout } = await runTmuxCommand(["display-message", "-p", "-t", sessionName, "#{session_attached}"], { access });
  return parseTmuxInteger(stdout);
}

function findTmeshTmuxSessionById(sessions: TmeshTmuxSession[], id: string): TmeshTmuxSession | undefined {
  const target = tmuxSessionNameFromId(id);
  const bareId = id.startsWith(tmuxSessionPrefix) ? id.slice(tmuxSessionPrefix.length) : id;
  return sessions.find((item) =>
    item.name === target ||
    item.name === id ||
    item.id === id ||
    item.id === bareId ||
    item.slurmJobId === id ||
    item.initialName === id ||
    item.initialName === target
  );
}

async function getTmeshTmuxSessionById(id: string, access?: TmeshTmuxAccess): Promise<TmeshTmuxSession> {
  const sessions = await listTmeshTmuxSessions(access);
  const session = findTmeshTmuxSessionById(sessions, id);
  if (!session) throw new Error(`TensorMesh session not found: ${id}`);
  return session;
}

export async function listTmeshTmuxSessions(access?: TmeshTmuxAccess): Promise<TmeshTmuxSession[]> {
  let stdout = "";
  try {
    ({ stdout } = await runTmuxCommand([
      "list-sessions",
      "-F",
      "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}|#{session_activity}|#{session_path}|#{@tmesh_shell_pane}|#{@tmesh_user}|#{@tmesh_slurm_job}|#{@tmesh_job_name}|#{@tmesh_reason}|#{@tmesh_initial_session}|#{@tmesh_release_on_detach}|#{@tmesh_submitted}|#{@tmesh_log}|#{@tmesh_command}"
    ], { access }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no server running|failed to connect|no sessions|error connecting|No such file or directory/i.test(message)) return [];
    throw error;
  }

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter(([name]) => name?.startsWith(tmuxSessionPrefix))
    .map((columns) => {
      const [name, attached, windows, created, activity, cwd, shellPane, owner, slurmJobId, jobName, reason, initialName, releaseOnDetach, submitted, , ...commandParts] = columns;
      const attachedClients = parseTmuxInteger(attached);
      return {
        id: tmuxSessionIdFromName(name),
        name,
        initialName: clean(initialName),
        shellPane: clean(shellPane),
        owner: clean(owner),
        slurmJobId: clean(slurmJobId),
        attached: attachedClients > 0,
        attachedClients,
        windows: Number(windows) || 0,
        createdAt: parseTmuxEpoch(created),
        lastActivityAt: parseTmuxEpoch(activity),
        cwd: clean(cwd),
        jobName: clean(jobName),
        reason: clean(reason),
        command: clean(commandParts.join("|")),
        releaseOnDetach: parseTmuxBoolean(releaseOnDetach),
        submitted: parseTmuxBoolean(submitted)
      };
    });
}

export async function openTmeshTmuxSession(id: string): Promise<number> {
  const sessionName = (await getTmeshTmuxSessionById(id)).name;
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", tmuxArgs(["attach-session", "-t", sessionName]), {
      stdio: "inherit"
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("tmux command not found. Install tmux first."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      releaseTmeshTmuxSessionIfUnused(sessionName)
        .catch(() => undefined)
        .finally(() => resolve(code ?? 0));
    });
  });
}

function parseTmuxPaneState(row: string): TmeshTmuxPaneState {
  const [paneId, active, inMode, dead, currentCommand, cursorX, cursorY, windowZoomed] = row.split("|");
  return {
    paneId: clean(paneId),
    active: parseTmuxBoolean(active),
    inMode: parseTmuxBoolean(inMode),
    dead: parseTmuxBoolean(dead),
    currentCommand: clean(currentCommand),
    cursorX: Number.isFinite(Number(cursorX)) ? Number(cursorX) : undefined,
    cursorY: Number.isFinite(Number(cursorY)) ? Number(cursorY) : undefined,
    windowZoomed: parseTmuxBoolean(windowZoomed)
  };
}

async function getTmeshTmuxLogPath(sessionName: string, access?: TmeshTmuxAccess): Promise<string | undefined> {
  try {
    const { stdout } = await runTmuxCommand(["show-options", "-v", "-t", sessionName, "@tmesh_log"], { access });
    return clean(stdout);
  } catch {
    return undefined;
  }
}

async function readTailIfAvailable(filePath: string | undefined, maxBytes: number): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    const content = await readFile(filePath);
    return content.subarray(Math.max(0, content.length - maxBytes)).toString("utf8");
  } catch {
    return undefined;
  }
}

export async function getTmeshTmuxSessionSnapshot(
  id: string,
  options: { startLine?: number; lineCount?: number; logBytes?: number; access?: TmeshTmuxAccess } = {}
): Promise<TmeshTmuxSessionSnapshot> {
  const session = await getTmeshTmuxSessionById(id, options.access);
  const targetPane = session.shellPane ?? session.name;
  const startLine = Number.isFinite(options.startLine) ? Math.trunc(options.startLine as number) : -200;
  const lineCount = Math.max(1, Math.min(Math.trunc(options.lineCount ?? 200), 2000));
  const endLine = startLine < 0 ? "-1" : String(startLine + lineCount - 1);
  const logBytes = Math.max(0, Math.min(Math.trunc(options.logBytes ?? 64 * 1024), 512 * 1024));
  const [screenResult, paneResult, logPath] = await Promise.all([
    runTmuxCommand(["capture-pane", "-p", "-J", "-t", targetPane, "-S", String(startLine), "-E", endLine], { access: options.access }),
    runTmuxCommand([
      "display-message",
      "-p",
      "-t",
      targetPane,
      "#{pane_id}|#{pane_active}|#{pane_in_mode}|#{pane_dead}|#{pane_current_command}|#{cursor_x}|#{cursor_y}|#{window_zoomed_flag}"
    ], { access: options.access }),
    getTmeshTmuxLogPath(session.name, options.access)
  ]);

  return {
    session,
    targetPane,
    capturedAt: new Date().toISOString(),
    pane: parseTmuxPaneState(paneResult.stdout.trim()),
    screen: screenResult.stdout.trimEnd(),
    logPath,
    logTail: await readTailIfAvailable(logPath, logBytes)
  };
}

export async function sendTmeshTmuxSessionInput(
  id: string,
  input: string,
  options: { enter?: boolean; literal?: boolean; access?: TmeshTmuxAccess } = {}
): Promise<TmeshTmuxSendInputResult> {
  const session = await getTmeshTmuxSessionById(id, options.access);
  const targetPane = session.shellPane ?? session.name;
  const normalized = input.replace(/\r\n/g, "\n");
  if (normalized.length > 16 * 1024) throw new Error("input is too large; limit is 16 KiB");
  const args = options.literal === false
    ? ["send-keys", "-t", targetPane, normalized]
    : ["send-keys", "-t", targetPane, "-l", "--", normalized];
  await runTmuxCommand(args, { access: options.access });
  const enter = options.enter !== false;
  if (enter) {
    await runTmuxCommand(["send-keys", "-t", targetPane, "Enter"], { access: options.access });
  }
  return {
    id: session.id,
    name: session.name,
    targetPane,
    sent: true,
    inputLength: normalized.length,
    enter
  };
}

async function inferTmeshSessionJobId(sessionName: string): Promise<string | undefined> {
  try {
    const { stdout } = await runTmuxCommand(["show-options", "-v", "-t", sessionName, "@tmesh_slurm_job"]);
    const fromOption = clean(stdout);
    if (fromOption) return fromOption;
  } catch {
    // Fall through to pane capture.
  }

  try {
    const { stdout } = await runTmuxCommand(["capture-pane", "-p", "-t", sessionName, "-S", "-200"]);
    return parseTensorMeshJobId(stdout);
  } catch {
    return undefined;
  }
}

export async function closeTmeshTmuxSession(id: string, options: { cancelSlurm?: boolean } = {}): Promise<TmeshTmuxCloseResult> {
  const session = await getTmeshTmuxSessionById(id);
  const slurmJobId = session.slurmJobId ?? await inferTmeshSessionJobId(session.name);
  let cancelledSlurmJob = false;
  let cancelError: string | undefined;

  if (options.cancelSlurm !== false && slurmJobId) {
    try {
      await cancelSlurmJob(slurmJobId);
      cancelledSlurmJob = true;
    } catch (error) {
      cancelError = error instanceof Error ? error.message : String(error);
    }
  }

  await runTmuxCommand(["kill-session", "-t", session.name]).catch((error) => {
    throw new Error(`failed to kill tmux session ${session.name}: ${error instanceof Error ? error.message : String(error)}`);
  });

  return {
    id: session.id,
    name: session.name,
    slurmJobId,
    cancelledSlurmJob,
    cancelError
  };
}

export async function releaseTmeshTmuxSessionIfUnused(id: string): Promise<TmeshTmuxReleaseResult> {
  let session: TmeshTmuxSession;
  try {
    session = await getTmeshTmuxSessionById(id);
  } catch {
    return {
      id: tmuxSessionIdFromName(id),
      name: tmuxSessionNameFromId(id),
      released: false,
      cancelledSlurmJob: false,
      reason: "session not found"
    };
  }

  const attachedClients = await getTmeshTmuxAttachedClients(session.name).catch(() => session.attachedClients);
  if (attachedClients > 0) {
    return {
      id: session.id,
      name: session.name,
      slurmJobId: session.slurmJobId,
      released: false,
      cancelledSlurmJob: false,
      reason: `${attachedClients} client(s) still attached`
    };
  }

  if (!session.releaseOnDetach) {
    return {
      id: session.id,
      name: session.name,
      slurmJobId: session.slurmJobId,
      released: false,
      cancelledSlurmJob: false,
      reason: "release on detach is disabled"
    };
  }

  if (session.submitted) {
    return {
      id: session.id,
      name: session.name,
      slurmJobId: session.slurmJobId,
      released: false,
      cancelledSlurmJob: false,
      reason: "session was submitted to background"
    };
  }

  const slurmJobId = session.slurmJobId ?? await inferTmeshSessionJobId(session.name);
  let cancelledSlurmJob = false;
  let cancelError: string | undefined;

  if (slurmJobId) {
    try {
      await cancelSlurmJob(slurmJobId);
      cancelledSlurmJob = true;
    } catch (error) {
      cancelError = error instanceof Error ? error.message : String(error);
    }
  }

  await runTmuxCommand(["kill-session", "-t", session.name]).catch(() => undefined);

  return {
    id: session.id,
    name: session.name,
    slurmJobId,
    released: true,
    cancelledSlurmJob,
    cancelError
  };
}

async function createAndAttachTmeshTmuxSession(input: {
  sessionName: string;
  cwd: string;
  jobName: string;
  reason?: string;
  commandLabel: string;
  startCommand: string;
  cleanupDir?: string;
  releaseOnDetach?: boolean;
}): Promise<number> {
  const runtimeDir = input.cleanupDir ?? await mkdtemp(path.join(os.tmpdir(), "tmesh-tmux-"));
  await mkdir(runtimeDir, { recursive: true });
  const scriptPath = path.join(runtimeDir, "start.sh");
  const gatePath = path.join(runtimeDir, "start.ready");
  const bootstrap = [
    "set -uo pipefail",
    `cd ${shellQuote([input.cwd])}`,
    "code=0",
    `${input.startCommand} || code=$?`,
    `rm -rf ${shellQuote([runtimeDir])} 2>/dev/null || true`,
    "if [ \"$code\" -ne 0 ]; then",
    "  printf '\\n[TensorMesh] interactive command exited with code %s. Press Enter to close this session.\\n' \"$code\"",
    "  read -r _ || true",
    "fi",
    "exit \"$code\""
  ].join("\n");
  await writeFile(scriptPath, `${bootstrap}\n`, "utf8");
  const gatedCommand = [
    `while [ ! -f ${shellQuote([gatePath])} ]; do sleep 0.05; done`,
    `exec bash ${shellQuote([scriptPath])}`
  ].join("; ");

  await runTmuxCommand([
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    shellQuote(["bash", "-lc", gatedCommand])
  ], { cwd: input.cwd });
  const { stdout: shellPane } = await runTmuxCommand(["display-message", "-p", "-t", input.sessionName, "#{pane_id}"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status", "on"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-style", "bg=colour28,fg=white"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-left-length", "64"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-right-length", "72"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-interval", "10"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "history-limit", "50000"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "mouse", "on"]);
  await runTmuxCommand(["set-window-option", "-t", input.sessionName, "mode-keys", "vi"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "window-status-format", ""]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "window-status-current-format", ""]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "window-status-separator", ""]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-left", "#[bold] TensorMesh "]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "status-right", "%H:%M %Y-%m-%d"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_initial_session", input.sessionName]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_shell_pane", shellPane.trim()]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_user", getCurrentUser()]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_release_on_detach", input.releaseOnDetach === false ? "0" : "1"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_job_name", input.jobName]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_reason", input.reason ?? "-"]);
  await runTmuxCommand(["set-option", "-t", input.sessionName, "@tmesh_command", input.commandLabel]);
  if (input.releaseOnDetach !== false) {
    const releaseCommand = [
      "sleep 0.2;",
      `TENSORMESH_TMUX_SOCKET=${shellQuote([tmuxSocketName])}`,
      shellQuote([tmeshCommand]),
      "__release-tmux",
      shellQuote([input.sessionName]),
      ">/dev/null",
      "2>&1"
    ].join(" ");
    await runTmuxCommand([
      "set-hook",
      "-t",
      input.sessionName,
      "client-detached",
      `run-shell -b ${shellQuote([releaseCommand])}`
    ]);
  }
  const commandPromptArgs = [
    "/usr/bin/python3",
    shellQuote([tmuxCommandPrompt]),
    "--socket",
    shellQuote([tmuxSocketName]),
    "--tmesh",
    shellQuote([tmeshCommand]),
    "--mode-script",
    shellQuote([tmuxCommandMode]),
    "--target-pane",
    "self"
  ].join(" ");
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "Escape",
    "split-window",
    "-l",
    "16",
    commandPromptArgs
  ]);
  const paneMenuArgs = [
    "display-menu",
    "-T",
    "#[align=centre]#{pane_index} (#{pane_id})",
    "-t",
    "=",
    "-x",
    "M",
    "-y",
    "M",
    "#{?mouse_word,Search For #[underscore]#{=/9/...:mouse_word},-Search Word}",
    "C-r",
    "copy-mode -t=; send -Xt= search-backward \"#{q:mouse_word}\"",
    "#{?mouse_word,Type #[underscore]#{=/9/...:mouse_word},-Type Word}",
    "C-y",
    "send-keys -l -- \"#{q:mouse_word}\"",
    "#{?mouse_word,Copy #[underscore]#{=/9/...:mouse_word},-Copy Word}",
    "c",
    "set-buffer -- \"#{q:mouse_word}\"",
    "#{?mouse_line,Copy Line,-Copy Line}",
    "l",
    "set-buffer -- \"#{q:mouse_line}\"",
    "",
    "",
    "",
    "Horizontal Split",
    "h",
    "split-window -h",
    "Vertical Split",
    "v",
    "split-window -v",
    "",
    "",
    "",
    "Swap Up",
    "u",
    "swap-pane -U",
    "Swap Down",
    "d",
    "swap-pane -D",
    "#{?pane_marked_set,,-}Swap Marked",
    "s",
    "swap-pane",
    "",
    "",
    "",
    "Kill",
    "X",
    "kill-pane",
    "Respawn",
    "R",
    "respawn-pane -k",
    "#{?pane_marked,Unmark,Mark}",
    "m",
    "select-pane -m",
    "#{?window_zoomed_flag,Unzoom,Zoom}",
    "z",
    "resize-pane -Z"
  ];
  const statusMenuArgs = [
    "display-menu",
    "-T",
    "#[align=centre]#{window_index}:#{window_name}",
    "-t",
    "=",
    "-x",
    "W",
    "-y",
    "S",
    "Swap Left",
    "l",
    "swap-window -t:-1",
    "Swap Right",
    "r",
    "swap-window -t:+1",
    "#{?pane_marked_set,,-}Swap Marked",
    "s",
    "swap-window",
    "",
    "",
    "",
    "Kill",
    "X",
    "kill-window",
    "Respawn",
    "R",
    "respawn-window -k",
    "#{?pane_marked,Unmark,Mark}",
    "m",
    "select-pane -m",
    "Rename",
    "n",
    "command-prompt -I \"#W\" \"rename-window -- '%%'\"",
    "",
    "",
    "",
    "New After",
    "w",
    "new-window -a",
    "New At End",
    "W",
    "new-window"
  ];
  const statusLeftMenuArgs = [
    "display-menu",
    "-T",
    "#[align=centre]#{session_name}",
    "-t",
    "=",
    "-x",
    "M",
    "-y",
    "S",
    "Next",
    "n",
    "switch-client -n",
    "Previous",
    "p",
    "switch-client -p",
    "",
    "",
    "",
    "Renumber",
    "N",
    "move-window -r",
    "Rename",
    "n",
    "command-prompt -I \"#S\" \"rename-session -- '%%'\"",
    "",
    "",
    "",
    "New Session",
    "s",
    "new-session",
    "New Window",
    "w",
    "new-window"
  ];
  const statusRightMenuArgs = [
    "display-menu",
    "-T",
    "#[align=centre]#{client_name}",
    "-t",
    "=",
    "-x",
    "M",
    "-y",
    "S",
    "Detach",
    "d",
    "detach-client",
    "Detach & Kill",
    "X",
    "detach-client -P",
    "Detach Others",
    "o",
    "detach-client -a",
    "",
    "",
    "",
    "Lock",
    "l",
    "lock-client"
  ];
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "MouseDown2Pane",
    ...paneMenuArgs
  ]);
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "MouseDown2Status",
    ...statusMenuArgs
  ]);
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "MouseDown2StatusLeft",
    ...statusLeftMenuArgs
  ]);
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "MouseDown2StatusRight",
    ...statusRightMenuArgs
  ]);
  await runTmuxCommand([
    "bind-key",
    "-T",
    "root",
    "MouseDown3Pane",
    "send-keys",
    "-N",
    "0"
  ]);
  for (const mouseKey of ["MouseDown3Status", "MouseDown3StatusLeft", "MouseDown3StatusRight", "M-MouseDown3Pane"]) {
    await runTmuxCommand([
      "bind-key",
      "-T",
      "root",
      mouseKey,
      "send-keys",
      "-N",
      "0"
    ]);
  }
  await writeFile(gatePath, "", "utf8");
  return openTmeshTmuxSession(input.sessionName);
}

export async function submitSlurmJob(input: SlurmRunInput): Promise<SlurmRunResult> {
  validateRunInput(input);
  const estimatedHours = parseEstimatedHours(input.time ?? "24");
  const estimatedEndAt = estimateEndAt(estimatedHours, estimateBaseDate(input.begin));
  const comment = encodeComment(estimatedHours, estimatedEndAt, input.notice, input.taskDescription);

  const normalized = {
    ...input,
    gpus: input.gpus ?? input.gpuIndexes?.length,
    name: input.name ?? "tmesh-job",
    slurmTime: input.slurmTime ?? defaultSlurmTimeLimit,
    cwd: input.cwd ?? process.cwd(),
    partition: input.partition ?? "gpu",
    cpusPerGpu: input.cpusPerGpu ?? defaultCpusPerGpu,
    memPerGpu: input.memPerGpu ?? defaultMemPerGpu
  };
  const managedLogBase = normalized.output ? undefined : path.join(normalized.cwd, ".tmesh");
  const outputPath = normalized.output ? normalizeOutputPath(normalized.output, normalized.cwd) : defaultRunLogTemplate(normalized.cwd);
  if (managedLogBase) {
    await mkdir(managedLogBase, { recursive: true });
  } else {
    await mkdir(path.dirname(outputPath), { recursive: true });
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tmesh-slurm-"));
  const scriptPath = path.join(tmpDir, "job.sbatch");

  try {
    await writeFile(scriptPath, buildBatchScript(normalized, managedLogBase), "utf8");
    const sbatchArgs = [
      "--parsable",
      `--partition=${normalized.partition}`,
      `--gres=${buildGres(normalized)}`,
      `--job-name=${normalized.name}`,
      `--time=${normalized.slurmTime}`,
      `--chdir=${normalized.cwd}`,
      `--output=${managedLogBase ? "/dev/null" : outputPath}`
    ];

    if (comment) sbatchArgs.push(`--comment=${comment}`);
    if (normalized.begin) sbatchArgs.push(`--begin=${normalized.begin}`);
    sbatchArgs.push(...gpuResourceArgs(normalized));

    sbatchArgs.push(scriptPath);

    const { stdout } = await runSlurmCommand("sbatch", sbatchArgs, { cwd: normalized.cwd });
    const jobId = stdout.split(";")[0]?.trim();
    if (!jobId) throw new Error(`sbatch did not return a job id: ${stdout}`);
    return {
      jobId,
      rawOutput: stdout,
      estimatedHours,
      estimatedEndAt,
      outputPath
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runInteractiveSlurm(input: SlurmInteractiveInput): Promise<number> {
  const useDefaultCommand = input.command === undefined;
  let command = input.command ?? ["bash", "-lc", "true"];
  let tmpDir: string | undefined;
  const useTmux = process.stdin.isTTY && process.stdout.isTTY && process.env.TENSORMESH_BASH_TMUX !== "0";
  const sessionName = useTmux ? createTmuxSessionName({ name: input.name ?? "tmesh-bash" }) : undefined;
  const cwd = input.cwd ?? process.cwd();
  validateRunInput({ ...input, command });
  if (useDefaultCommand) {
    const rc = await createInteractiveShellRc(sessionName ? path.join(os.tmpdir(), sessionName) : undefined);
    tmpDir = rc.tmpDir;
    command = buildDefaultInteractiveCommand(rc.rcPath, cwd);
  } else if (useTmux) {
    command = buildInteractiveCommand(command, cwd);
  }
  const estimatedHours = parseEstimatedHours(input.time ?? "24");
  const estimatedEndAt = estimateEndAt(estimatedHours, estimateBaseDate(input.begin));
  const comment = encodeComment(estimatedHours, estimatedEndAt, input.notice, input.taskDescription);
  const normalized = {
    ...input,
    gpus: input.gpus ?? input.gpuIndexes?.length,
    name: input.name ?? "tmesh-bash",
    slurmTime: input.slurmTime ?? defaultSlurmTimeLimit,
    cwd,
    partition: input.partition ?? "gpu",
    cpusPerGpu: input.cpusPerGpu ?? defaultCpusPerGpu,
    memPerGpu: input.memPerGpu ?? defaultMemPerGpu,
    command
  };
  const srunArgs = [
    `--partition=${normalized.partition}`,
    `--gres=${buildGres(normalized)}`,
    `--job-name=${normalized.name}`,
    `--time=${normalized.slurmTime}`,
    `--chdir=${normalized.cwd}`,
  ];

  if (comment) srunArgs.push(`--comment=${comment}`);
  srunArgs.push(...gpuResourceArgs(normalized));

  srunArgs.push("--pty", ...normalized.command);

  if (useTmux) {
    const tmuxName = sessionName ?? createTmuxSessionName({ name: normalized.name });
    const releaseOnDetach = process.env.TENSORMESH_TMUX_RELEASE_ON_DETACH !== "0";
    try {
      return await createAndAttachTmeshTmuxSession({
        sessionName: tmuxName,
        cwd: normalized.cwd,
        jobName: normalized.name,
        reason: normalized.taskDescription,
        commandLabel: normalized.command.join(" "),
        startCommand: `TMESH_TMUX_SOCKET=${shellQuote([tmuxSocketName])} TMESH_TMUX_SESSION=${shellQuote([tmuxName])} TMESH_TMUX_RELEASE_ON_DETACH=${releaseOnDetach ? "1" : "0"} ${shellQuote([srunCommand, ...srunArgs])}`,
        cleanupDir: tmpDir,
        releaseOnDetach
      });
    } finally {
      if (tmpDir && process.env.TENSORMESH_BASH_TMUX === "0") await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const wrapperArgs = [
    interactiveWrapper,
    "--repo-root",
    repoRoot,
    "--cwd",
    normalized.cwd,
    "--",
    ...srunArgs
  ];

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/python3", wrapperArgs, {
        cwd: normalized.cwd,
        stdio: "inherit",
        env: { ...process.env, TENSORMESH_SRUN: srunCommand }
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(new Error("Python command not found: /usr/bin/python3. Install Python 3 first."));
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        resolve(code ?? 0);
      });
    });
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
