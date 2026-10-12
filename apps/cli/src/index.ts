#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  formatMemory,
  formatPercent,
  getMockGpuHistory,
  getMockSystemStatus,
  getMockUsageSummary,
  isActiveSlurmJobState,
  type GpuStatus,
  type SlurmJob,
  type SlurmJobHistory,
  type SlurmJobHistoryEntry,
  type SlurmNode,
  type SystemStatus
} from "@tensormesh/shared";
import {
  cancelSlurmJob,
  closeTmeshTmuxSession,
  createWebToken,
  formatEstimatedEnd,
  formatEstimatedHours,
  getCurrentUser,
  getWebTokenSecretPath,
  getSlurmJob,
  getSlurmJobs,
  getSlurmStatus,
  listTmeshTmuxSessions,
  openTmeshTmuxSession,
  queryGpuRows,
  releaseTmeshTmuxSessionIfUnused,
  runNvidiaSmi,
  runInteractiveSlurm,
  submitSlurmJob
} from "@tensormesh/shared/node";
import { confirmCancelJob, runCancelCommand, selectCancelJob } from "./cancel";
import {
  cancelSharedTask,
  listSharedTasks,
  runSharedTask,
} from "./share";
import { runUploadCommand } from "./upload";

const apiBase = process.env.TENSORMESH_API ?? "http://localhost:4317";
const execFileAsync = promisify(execFile);
const systemEnvPath = "/etc/tensormesh/tensormesh.env";
const systemEnv = readSystemEnv();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const externalGpuBindScript = path.join(repoRoot, "packages", "shared", "src", "external_gpu_bind.py");
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

type OutputMode = "pretty" | "plain" | "json";

function initialOutputMode(): OutputMode {
  const configured = process.env.TENSORMESH_OUTPUT;
  if (configured === "json" || configured === "plain" || configured === "pretty") {
    return configured;
  }

  return process.stdout.isTTY === true ? "pretty" : "plain";
}

let outputMode: OutputMode = initialOutputMode();

interface TableColumn {
  header: string;
  min: number;
  ideal: number;
  grow?: number;
  priority?: number;
  align?: "left" | "right";
}

interface GpuRowData {
  index: number;
  name: string;
  memory: string;
  util: string;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  utilizationPercent?: number;
  user: string;
  task: string;
  state: string;
}

interface NoticeSettings {
  user: string;
  reminderEmail?: string;
  notifyJobFinished: boolean;
  notifyReservationStarted: boolean;
  notifyJobOverdue: boolean;
  notifyLowGpu: boolean;
  noticeMode: "explicit" | "global";
  lowGpuMinutes: number;
  lowGpuThreshold: number;
  updatedAt?: string;
}

interface SessionInfo {
  user: string;
  expiresAt?: string;
  settings: NoticeSettings;
  mail?: {
    configured: boolean;
    endpoint: string;
    fromName: string;
    tokenSource: "env" | "file" | "missing";
    tokenFile?: string;
  };
}

interface NvidiaSmiCliResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SacctJobHistoryRow {
  JobIDRaw?: string;
  JobID?: string;
  JobName?: string;
  User?: string;
  State?: string;
  Partition?: string;
  AllocNodes?: string;
  NodeList?: string;
  Elapsed?: string;
  Timelimit?: string;
  Submit?: string;
  Start?: string;
  End?: string;
  ExitCode?: string;
  ReqTRES?: string;
  AllocTRES?: string;
  WorkDir?: string;
  Comment?: string;
}

class TaskCreationCancelledError extends Error {
  constructor() {
    super("已取消创建。");
    this.name = "TaskCreationCancelledError";
  }
}

interface NoticeOptionItem {
  key: keyof Pick<NoticeSettings, "notifyJobFinished" | "notifyReservationStarted" | "notifyJobOverdue" | "notifyLowGpu">;
  label: string;
  description: string;
}

const noticeOptions: NoticeOptionItem[] = [
  {
    key: "notifyJobFinished",
    label: "Job finish",
    description: "job 自然完成退出提醒"
  },
  {
    key: "notifyReservationStarted",
    label: "Reservation start",
    description: "预约/排队的 job 开始运行提醒"
  },
  {
    key: "notifyJobOverdue",
    label: "Job overdue",
    description: "job 超过 100% 预计时间仍未结束提醒"
  },
  {
    key: "notifyLowGpu",
    label: "Low GPU utilization",
    description: "GPU 平均利用率低于阈值提醒"
  }
];

async function getStatus(): Promise<{ status: SystemStatus; source: "api" | "mock" }> {
  try {
    const response = await fetch(`${apiBase}/api/status`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return { status: (await response.json()) as SystemStatus, source: "api" };
  } catch {
    return { status: getMockSystemStatus(), source: "mock" };
  }
}

async function createCliToken(ttlHours = 12): Promise<string> {
  const ttlSeconds = Math.max(60, Math.round(ttlHours * 3600));
  return createWebToken({ user: getCurrentUser(), ttlSeconds });
}

async function apiJson<T>(path: string, init: RequestInit = {}, options: { signed?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (options.signed ?? true) {
    headers.set("authorization", `Bearer ${await createCliToken()}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { ...init, headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`TensorMesh API 不可访问：${apiBase}${path} (${reason})。请检查 tensormesh-api 服务和 TENSORMESH_API。`);
  }
  const payload = (await response.json().catch(() => null)) as { message?: string } | T | null;
  if (!response.ok) {
    throw new Error((payload && typeof payload === "object" && "message" in payload ? payload.message : undefined) ?? `API returned ${response.status}`);
  }
  return payload as T;
}

async function fetchSessionInfo(): Promise<SessionInfo> {
  return apiJson<SessionInfo>("/api/session");
}

async function patchNoticeSettings(input: Partial<Omit<NoticeSettings, "reminderEmail">> & { reminderEmail?: string | null }): Promise<NoticeSettings> {
  return apiJson<NoticeSettings>("/api/session/settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

async function sendNoticeTestMail(toMail?: string): Promise<{ ok: boolean; status: number; body: string }> {
  return apiJson<{ ok: boolean; status: number; body: string }>("/api/session/test-mail", {
    method: "POST",
    body: JSON.stringify(toMail ? { toMail } : {})
  });
}

async function fetchApiStatus(): Promise<SystemStatus | null> {
  try {
    const response = await fetch(`${apiBase}/api/status`);
    if (!response.ok) return null;
    return (await response.json()) as SystemStatus;
  } catch {
    return null;
  }
}

async function fetchApiNvidiaSmi(args: string[]): Promise<NvidiaSmiCliResult | null> {
  try {
    const url = new URL(`${apiBase}/api/nvidia-smi`);
    for (const arg of args) url.searchParams.append("arg", arg);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${await createCliToken()}`
      }
    });
    if (!response.ok) return null;
    return (await response.json()) as NvidiaSmiCliResult;
  } catch {
    return null;
  }
}

async function fetchApiJobHistory(args: string[]): Promise<SlurmJobHistory | null> {
  try {
    const url = new URL(`${apiBase}/api/jobs/history`);
    url.searchParams.set("days", String(historyDays(args)));
    url.searchParams.set("limit", String(historyLimit(args)));
    const active = parseActiveHistoryFilter(args);
    if (active !== undefined) url.searchParams.set("active", active ? "1" : "0");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${await createCliToken()}`
      }
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as SlurmJobHistory;
    return { ...payload, source: "api" };
  } catch {
    return null;
  }
}

function apiGpuRows(status: SystemStatus): GpuRowData[] {
  return status.gpus.map((gpu) => {
    const processUsers = gpu.processes.map((process) => process.username).filter(Boolean);
    const users = Array.from(new Set([
      gpu.currentTask?.user,
      gpu.reservation?.user,
      ...processUsers
    ].filter(Boolean) as string[]));
    const processLabel = gpu.processes.length === 1
      ? gpu.processes[0].pid > 0
        ? `${gpu.processes[0].command.split(/\s+/)[0] ?? "process"} pid=${gpu.processes[0].pid} ${Math.round(gpu.processes[0].memoryUsedMb / 1024)}GB`
        : gpu.processes[0].command
      : gpu.processes.length > 1
        ? `${gpu.processes.length} GPU processes`
        : undefined;
    const task = gpu.currentTask
      ? `${gpu.currentTask.project} - ${gpu.currentTask.content}`
      : gpu.reservation
        ? `${gpu.reservation.project} - ${gpu.reservation.content}`
        : processLabel ?? "-";

    return {
      index: gpu.index,
      name: gpu.name,
      memory: formatMemory(gpu.memoryUsedMb, gpu.memoryTotalMb),
      util: formatPercent(gpu.utilizationPercent),
      memoryUsedMb: gpu.memoryUsedMb,
      memoryTotalMb: gpu.memoryTotalMb,
      utilizationPercent: gpu.utilizationPercent,
      user: users.length > 0 ? users.join(",") : "-",
      task,
      state: stateLabel(gpu.state)
    };
  });
}

async function getRealGpuRows(): Promise<GpuRowData[]> {
  const apiStatus = await fetchApiStatus();
  if (apiStatus?.gpus.length) return apiGpuRows(apiStatus);

  try {
    return (await queryGpuRows()).map((row) => {
      const parsedMemory = parseMemoryLabel(row.memory);
      return {
        ...row,
        memoryUsedMb: parsedMemory?.usedMb,
        memoryTotalMb: parsedMemory?.totalMb,
        utilizationPercent: parsePercentLabel(row.util)
      };
    });
  } catch {
    return [];
  }
}

function stateLabel(state: GpuStatus["state"]): string {
  if (state === "running") return "running";
  if (state === "reserved") return "reserved";
  if (state === "idle") return "idle";
  return "unknown";
}

function pad(value: string | number, width: number): string {
  const text = String(value);
  if (text.length > width) {
    return `${text.slice(0, Math.max(0, width - 4))}... `;
  }

  return text.padEnd(width, " ");
}

function isPlainOutput(): boolean {
  return outputMode === "plain" || Boolean(process.env.NO_COLOR);
}

function color(text: string, tone?: string): string {
  if (isPlainOutput()) return text;
  if (tone === "ok") return `${colors.green}${text}${colors.reset}`;
  if (tone === "warn") return `${colors.yellow}${text}${colors.reset}`;
  if (tone === "bad") return `${colors.red}${text}${colors.reset}`;
  if (tone === "info") return `${colors.cyan}${text}${colors.reset}`;
  if (tone === "muted") return `${colors.gray}${text}${colors.reset}`;
  if (tone === "bold") return `${colors.bold}${text}${colors.reset}`;
  if (tone === "border") return `${colors.gray}${text}${colors.reset}`;
  return text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function truncateDisplay(text: string, width: number): string {
  let used = 0;
  let result = "";
  for (const char of text) {
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result;
}

function visibleLength(text: string | number): number {
  return displayWidth(stripAnsi(String(text)));
}

function fit(value: string | number, width: number): string {
  const text = String(value);
  const plain = stripAnsi(text);
  const plainWidth = displayWidth(plain);
  if (plainWidth > width) {
    const suffix = isPlainOutput() ? "..." : "…";
    const sliced = truncateDisplay(plain, Math.max(0, width - displayWidth(suffix)));
    return `${sliced}${suffix}`;
  }

  return `${text}${" ".repeat(width - plainWidth)}`;
}

function terminalWidth(): number {
  const defaultColumns = process.stdout.isTTY === true ? 120 : 80;
  const columns = Number(process.env.COLUMNS ?? process.stdout.columns ?? defaultColumns);
  if (!Number.isFinite(columns)) return 120;
  return Math.max(52, Math.floor(columns));
}

function columnGap(columnCount: number): number {
  return columnCount > 1 ? 2 : 0;
}

function tableBorderWidth(columnCount: number): number {
  return Math.max(0, columnCount - 1) * columnGap(columnCount);
}

function tableVisibleWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + tableBorderWidth(widths.length);
}

function contentLength(value: string | number): number {
  return visibleLength(value);
}

function selectedColumns(columns: TableColumn[], rows: Array<Array<string | number>>, targetWidth: number): number[] {
  let indexes = columns.map((_column, index) => index);

  const minimumWidth = (items: number[]) => tableVisibleWidth(items.map((index) => columns[index].min));

  while (indexes.length > 2 && minimumWidth(indexes) > targetWidth) {
    const removable = indexes
      .map((index) => ({ index, priority: columns[index].priority ?? 0 }))
      .filter((item) => item.priority > 0)
      .sort((a, b) => b.priority - a.priority)[0];

    if (!removable) break;
    indexes = indexes.filter((index) => index !== removable.index);
  }

  if (minimumWidth(indexes) <= targetWidth) return indexes;

  return indexes.filter((index) => {
    const column = columns[index];
    return column.priority === undefined || column.priority === 0 || rows.length === 0;
  });
}

function layoutColumns(columns: TableColumn[], rows: Array<Array<string | number>>, targetWidth = terminalWidth()): { indexes: number[]; widths: number[]; width: number } {
  const indexes = selectedColumns(columns, rows, targetWidth);
  const border = tableBorderWidth(indexes.length);
  const budget = Math.max(indexes.length * 3, targetWidth - border);
  const minimums = indexes.map((index) => Math.max(3, Math.min(columns[index].min, budget)));
  const widths = [...minimums];
  let remaining = Math.max(0, budget - widths.reduce((sum, width) => sum + width, 0));

  const desired = indexes.map((index, offset) => {
    const column = columns[index];
    const contentMax = Math.max(
      contentLength(column.header),
      ...rows.map((row) => contentLength(row[index] ?? ""))
    );
    return Math.max(widths[offset], Math.min(Math.max(column.ideal, contentMax), Math.max(column.ideal, column.min)));
  });

  while (remaining > 0) {
    const candidates = indexes
      .map((index, offset) => ({
        offset,
        grow: columns[index].grow ?? 1,
        capacity: Math.max(0, desired[offset] - widths[offset])
      }))
      .filter((item) => item.grow > 0 && item.capacity > 0);

    if (candidates.length === 0) break;
    const totalGrow = candidates.reduce((sum, item) => sum + item.grow, 0);
    let used = 0;

    for (const item of candidates) {
      const share = Math.max(1, Math.floor((remaining * item.grow) / totalGrow));
      const add = Math.min(item.capacity, share, remaining - used);
      widths[item.offset] += add;
      used += add;
      if (used >= remaining) break;
    }

    if (used === 0) break;
    remaining -= used;
  }

  const growIndexes = indexes
    .map((index, offset) => ({ offset, grow: columns[index].grow ?? 1 }))
    .filter((item) => item.grow > 0);
  let growCursor = 0;
  while (remaining > 0 && growIndexes.length > 0) {
    const item = growIndexes[growCursor % growIndexes.length];
    widths[item.offset] += 1;
    remaining -= 1;
    growCursor += 1;
  }

  return { indexes, widths, width: tableVisibleWidth(widths) };
}

function fitCell(value: string | number, width: number, align: "left" | "right" = "left"): string {
  const text = fit(value, width);
  if (align === "left") return text;
  const plain = stripAnsi(String(value));
  const plainWidth = displayWidth(plain);
  if (plainWidth >= width) return text;
  return `${" ".repeat(width - plainWidth)}${value}`;
}

function titleLine(title: string, subtitle?: string): string {
  return `${color(title, "bold")}${subtitle ? `  ${color(subtitle, "muted")}` : ""}`;
}

function formatClock(date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(date));
}

function rule(width = terminalWidth()): string {
  return color((isPlainOutput() ? "-" : "─").repeat(Math.max(12, Math.min(width, terminalWidth()))), "border");
}

function renderTable(title: string, columns: TableColumn[], rows: Array<Array<string | number>>, options: { maxWidth?: number } = {}): string {
  const targetWidth = options.maxWidth ? Math.min(terminalWidth(), options.maxWidth) : terminalWidth();
  const layout = layoutColumns(columns, rows, targetWidth);
  const selected = layout.indexes.map((index) => columns[index]);
  const widths = layout.widths;
  const gap = " ".repeat(columnGap(selected.length));
  const rowLine = (cells: Array<string | number>) => selected.map((column, offset) => fitCell(cells[layout.indexes[offset]] ?? "-", widths[offset], column.align)).join(gap);
  const separatorChar = isPlainOutput() ? "-" : "─";
  const separator = color(widths.map((width) => separatorChar.repeat(width)).join(gap), "border");
  const header = rowLine(selected.map((column) => color(column.header, "muted")));
  const body = rows.map(rowLine);

  return [
    stripAnsi(title) === title ? titleLine(title) : title,
    header,
    separator,
    ...body
  ].join("\n") + "\n";
}

function renderPanel(title: string, lines: Array<string | number>): string {
  const width = Math.min(terminalWidth(), Math.max(contentLength(title), ...lines.map(contentLength), 24));
  const contentWidth = Math.max(10, terminalWidth() - 2);
  const body = lines.map((line) => {
    const text = String(line);
    const suffix = isPlainOutput() ? "..." : "…";
    return visibleLength(text) > contentWidth ? `${truncateDisplay(stripAnsi(text), Math.max(0, contentWidth - displayWidth(suffix)))}${suffix}` : text;
  });
  return [
    titleLine(title),
    rule(width),
    ...body
  ].join("\n") + "\n";
}

interface PanelField {
  label: string;
  value: string | number;
  tone?: string;
}

function renderFieldPanel(title: string, fields: PanelField[]): string {
  const width = terminalWidth();
  const contentWidth = Math.max(10, width);
  const labelWidth = Math.min(14, Math.max(8, ...fields.map((field) => visibleLength(field.label))));
  const body = fields.map((field) => {
    const label = color(fit(field.label, labelWidth), "muted");
    const value = color(String(field.value), field.tone);
    const line = `${label}  ${value}`;
    const suffix = isPlainOutput() ? "..." : "…";
    return visibleLength(line) > contentWidth ? `${truncateDisplay(stripAnsi(line), Math.max(0, contentWidth - displayWidth(suffix)))}${suffix}` : line;
  });
  const bodyWidth = Math.min(width, Math.max(24, contentLength(title), ...body.map(contentLength)));
  return [
    titleLine(title),
    rule(bodyWidth),
    ...body
  ].join("\n") + "\n";
}

function stateTone(state: string): string {
  if (/idle|completed|running/i.test(state)) return "ok";
  if (/pending|reserved|mixed|mix/i.test(state)) return "warn";
  if (/fail|down|drain|error|cancel/i.test(state)) return "bad";
  return "muted";
}

function compactDiagnostic(value: string | undefined, maxParts = 3): string {
  const lines = (value ?? "unknown error")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const withoutCommand = lines.filter((line) => !line.startsWith("Command failed: "));
  const candidates = withoutCommand.length > 0 ? withoutCommand : lines;
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const line of candidates) {
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line.length > 180 ? `${line.slice(0, 177)}...` : line);
    if (parts.length >= maxParts) break;
  }

  return parts.length > 0 ? parts.join("; ") : "unknown error";
}

function estimateTone(job: SlurmJob): string {
  if (job.estimatedOverdue) return "bad";
  if (job.estimatedEndAt) return "info";
  return "muted";
}

function gpuTone(value: string | undefined): string {
  if (!value || value === "-") return "muted";
  return "info";
}

function formatMemoryMb(value: number | undefined): string {
  if (!Number.isFinite(value)) return "-";
  const mb = Number(value);
  if (mb >= 1024 * 1024) return `${Math.round((mb / 1024 / 1024) * 10) / 10}T`;
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10}G`;
  return `${Math.round(mb)}M`;
}

function parseMemoryLabel(value: string | undefined): { usedMb: number; totalMb: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|G|MB|M)?/i);
  if (!match) return undefined;
  const unit = (match[3] ?? "GB").toUpperCase();
  const multiplier = unit.startsWith("M") ? 1 : 1024;
  const usedMb = Number(match[1]) * multiplier;
  const totalMb = Number(match[2]) * multiplier;
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb)) return undefined;
  return { usedMb, totalMb };
}

function parsePercentLabel(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/-?\d+(\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Number(value)));
}

function usageBar(percent: number | undefined, width: number): string {
  const safeWidth = Math.max(4, width);
  const value = clampPercent(percent);
  if (value === undefined) return color((isPlainOutput() ? "." : "░").repeat(safeWidth), "muted");
  const filled = Math.round((value / 100) * safeWidth);
  const tone = value >= 90 ? "bad" : value >= 65 ? "warn" : value > 0 ? "ok" : "muted";
  const on = isPlainOutput() ? "#" : "█";
  const off = isPlainOutput() ? "." : "░";
  return `${color(on.repeat(filled), tone)}${color(off.repeat(safeWidth - filled), "muted")}`;
}

function gpuMemoryPercent(row: GpuRowData): number | undefined {
  const used = row.memoryUsedMb;
  const total = row.memoryTotalMb;
  if (!Number.isFinite(used) || !Number.isFinite(total) || Number(total) <= 0) return undefined;
  return (Number(used) / Number(total)) * 100;
}

function gpuMemoryLabel(row: GpuRowData): string {
  if (Number.isFinite(row.memoryUsedMb) && Number.isFinite(row.memoryTotalMb)) {
    const used = Number(row.memoryUsedMb);
    const total = Number(row.memoryTotalMb);
    const totalGb = Math.max(1, Math.round(total / 1024));
    const usedGb = used < 512 ? "0" : `${Math.round((used / 1024) * 10) / 10}`;
    return `${usedGb}/${totalGb}G`;
  }
  return row.memory;
}

function compactGpuModel(name: string): string {
  return name
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .replace(/^NVIDIA GeForce\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function gpuSummary(rows: GpuRowData[]): string {
  const total = rows.length;
  const running = rows.filter((row) => /running/i.test(row.state)).length;
  const reserved = rows.filter((row) => /reserved/i.test(row.state)).length;
  const idle = rows.filter((row) => /idle/i.test(row.state)).length;
  const activeUtilValues = rows
    .map((row) => clampPercent(row.utilizationPercent))
    .filter((value): value is number => value !== undefined);
  const avgUtil = activeUtilValues.length > 0
    ? `${Math.round(activeUtilValues.reduce((sum, value) => sum + value, 0) / activeUtilValues.length)}% avg`
    : "util n/a";
  return [
    `${total} cards`,
    color(`${running} running`, running > 0 ? "ok" : "muted"),
    color(`${reserved} reserved`, reserved > 0 ? "warn" : "muted"),
    color(`${idle} idle`, idle > 0 ? "info" : "muted"),
    color(avgUtil, "muted")
  ].join("   ");
}

function estimateLabel(job: SlurmJob): string {
  if (!job.estimatedEndAt) return "-";
  const end = formatEstimatedEnd(job.estimatedEndAt) ?? job.estimatedEndAt;
  const hours = formatEstimatedHours(job.estimatedHours);
  return `${job.estimatedOverdue ? "超时 " : ""}${hours ? `${hours} ` : ""}${end}`;
}

function compactEstimateLabel(job: SlurmJob): string {
  if (!job.estimatedEndAt) return "-";
  const hours = formatEstimatedHours(job.estimatedHours);
  if (job.estimatedOverdue) return `OVERDUE ${hours ?? ""}`.trim();
  const end = formatEstimatedEnd(job.estimatedEndAt);
  return end ?? "-";
}

function compactDuration(value: string | undefined): string {
  if (!value || value === "-") return "-";
  const dayMatch = value.match(/^(\d+)-(\d+):(\d+):(\d+)/);
  if (dayMatch) return `${dayMatch[1]}d${dayMatch[2]}h`;
  const hms = value.match(/^(\d+):(\d+):(\d+)/);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    if (hours > 0) return `${hours}h${minutes}m`;
    return `${minutes}m`;
  }
  return value;
}

function killCountdownLabel(job: SlurmJob): string {
  if (job.killRemaining) return compactDuration(job.killRemaining);
  if (/PENDING|REQUEUED/i.test(job.state) && job.timeLimit && job.timeLimit !== "-") {
    return `on start ${compactDuration(job.timeLimit)}`;
  }
  return "-";
}

function killCountdownTone(job: SlurmJob): string {
  if (job.killRemainingSeconds === undefined) return "muted";
  if (job.killRemainingSeconds <= 24 * 60 * 60) return "bad";
  if (job.killRemainingSeconds <= 3 * 24 * 60 * 60) return "warn";
  return "info";
}

function jobGpuLabel(job: SlurmJob): string {
  return job.gres ?? job.tres ?? "-";
}

function runningJobCount(jobs: SlurmJob[]): number {
  return jobs.filter((job) => /RUNNING|COMPLETING|CONFIGURING/i.test(job.state)).length;
}

function waitingJobCount(jobs: SlurmJob[]): number {
  return jobs.filter((job) => /PENDING|SUSPENDED/i.test(job.state)).length;
}

function overdueJobCount(jobs: SlurmJob[]): number {
  return jobs.filter((job) => job.estimatedOverdue).length;
}

function printJobSummary(title: string, jobs: SlurmJob[]): void {
  const running = runningJobCount(jobs);
  const waiting = waitingJobCount(jobs);
  const overdue = overdueJobCount(jobs);
  const parts = [
    `${jobs.length} total`,
    color(`${running} running`, running > 0 ? "ok" : "muted"),
    color(`${waiting} waiting`, waiting > 0 ? "warn" : "muted")
  ];
  if (overdue > 0) parts.push(color(`${overdue} overdue`, "bad"));
  parts.push(color(`updated ${formatClock()}`, "muted"));
  process.stdout.write(`${titleLine(title, parts.join("   "))}\n`);
}

function submittedEstimateLine(result: { estimatedHours?: number; estimatedEndAt?: string }): string | undefined {
  const end = formatEstimatedEnd(result.estimatedEndAt);
  if (!end) return undefined;
  const duration = formatEstimatedHours(result.estimatedHours);
  return `预计${duration ? ` ${duration} ` : " "}结束：${end}`;
}

function noticeModeLabel(mode: NoticeSettings["noticeMode"]): string {
  return mode === "global" ? "全局发送（所有任务按配置提醒）" : "显式发送（仅 --notice 任务提醒）";
}

function normalizeNoticeSettings(settings: NoticeSettings): NoticeSettings {
  return {
    ...settings,
    noticeMode: settings.noticeMode === "global" ? "global" : "explicit",
    lowGpuMinutes: Number.isFinite(Number(settings.lowGpuMinutes)) ? Number(settings.lowGpuMinutes) : 30,
    lowGpuThreshold: Number.isFinite(Number(settings.lowGpuThreshold)) ? Number(settings.lowGpuThreshold) : 50
  };
}

function printNoticeSettings(session: SessionInfo): void {
  const settings = normalizeNoticeSettings(session.settings);
  process.stdout.write(renderFieldPanel("TensorMesh Notice", [
    { label: "User", value: session.user, tone: "info" },
    { label: "Mail", value: settings.reminderEmail ?? "-", tone: settings.reminderEmail ? "ok" : "warn" },
    { label: "Mode", value: noticeModeLabel(settings.noticeMode), tone: settings.noticeMode === "global" ? "warn" : "info" },
    { label: "Mail API", value: session.mail?.configured ? `${session.mail.fromName} · ${session.mail.tokenSource}` : "not configured", tone: session.mail?.configured ? "ok" : "bad" },
    { label: "Low GPU", value: `${settings.lowGpuMinutes}m < ${settings.lowGpuThreshold}%`, tone: settings.notifyLowGpu ? "info" : "muted" },
    { label: "Updated", value: settings.updatedAt ?? "-", tone: "muted" }
  ]));

  process.stdout.write(renderTable(
    "Notice Options",
    [
      { header: "On", min: 4, ideal: 5 },
      { header: "Option", min: 18, ideal: 24, grow: 1 },
      { header: "Description", min: 24, ideal: 56, grow: 2 }
    ],
    noticeOptions.map((item) => [
      settings[item.key] ? color("[x]", "ok") : color("[ ]", "muted"),
      item.label,
      item.description
    ])
  ));
}

function printSection(title: string, subtitle?: string): void {
  process.stdout.write(`${color(title, "bold")}${subtitle ? `  ${color(subtitle, "muted")}` : ""}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSlurmNodes(nodes: SlurmNode[]): void {
  if (nodes.length === 0) {
    process.stdout.write(`${color("No Slurm nodes reported.", "muted")}\n`);
    return;
  }

  const totalCpus = nodes.reduce((sum, node) => sum + (node.cpus ?? 0), 0);
  const totalGpus = nodes.reduce((sum, node) => sum + countGpusInGres(node.gres), 0);
  const subtitle = `${nodes.length} node${nodes.length === 1 ? "" : "s"}   ${totalCpus} CPUs   ${totalGpus} GPUs`;
  process.stdout.write(renderTable(
    titleLine("Slurm Nodes", subtitle),
    [
      { header: "Node", min: 8, ideal: 18, grow: 1 },
      { header: "State", min: 7, ideal: 12 },
      { header: "CPUs", min: 4, ideal: 6, align: "right", priority: 3 },
      { header: "Mem", min: 7, ideal: 9, align: "right", priority: 2 },
      { header: "GRES", min: 12, ideal: 52, grow: 4 }
    ],
    nodes.map((node) => [
      node.name,
      color(node.state, stateTone(node.state)),
      node.cpus ?? "-",
      node.memoryMb ? formatMemoryMb(node.memoryMb) : "-",
      node.gres ?? "-"
    ])
  ));
}

function printSlurmJobs(jobs: SlurmJob[]): void {
  if (outputMode === "json") {
    printJson(jobs);
    return;
  }

  if (jobs.length === 0) {
    process.stdout.write(`${color("No Slurm jobs found.", "muted")}\n`);
    return;
  }

  printJobSummary("Slurm Jobs", jobs);

  if (terminalWidth() < 82) {
    for (const job of jobs) {
      process.stdout.write([
        `${color(`#${job.id}`, "bold")}  ${color(job.state, stateTone(job.state))}  ${job.user}  ${color(jobGpuLabel(job), gpuTone(jobGpuLabel(job)))}`,
        `  ${job.name}`,
        `  Time ${compactDuration(job.elapsed)} / ${compactDuration(job.timeLimit)}   Kill in ${color(killCountdownLabel(job), killCountdownTone(job))}`,
        `  Expect ${color(compactEstimateLabel(job), estimateTone(job))}`,
        `  Reason ${job.reason && job.reason !== "None" ? color(job.reason, "warn") : color("-", "muted")}`
      ].join("\n") + "\n");
    }
    return;
  }

  const columns: TableColumn[] = [
    { header: "JOB", min: 5, ideal: 6, align: "right" },
    { header: "STATE", min: 8, ideal: 10 },
    { header: "GPU", min: 8, ideal: 14, grow: 2 },
    { header: "USER", min: 6, ideal: 9 },
    { header: "AGE", min: 7, ideal: 9 },
    { header: "KILL IN", min: 9, ideal: 14 },
    { header: "EXPECT", min: 12, ideal: 22, grow: 2 },
    { header: "NAME", min: 12, ideal: 26, grow: 3 }
  ];
  const layout = layoutColumns(columns, jobs.map((job) => [
    job.id,
    job.state,
    jobGpuLabel(job),
    job.user,
    compactDuration(job.elapsed),
    killCountdownLabel(job),
    compactEstimateLabel(job),
    job.name
  ]));
  const selected = layout.indexes.map((index) => columns[index]);
  const gap = "  ";
  const rowLine = (cells: Array<string | number>) => selected.map((column, offset) => fitCell(cells[layout.indexes[offset]] ?? "-", layout.widths[offset], column.align)).join(gap);
  const separatorChar = isPlainOutput() ? "-" : "─";
  const separator = color(layout.widths.map((width) => separatorChar.repeat(width)).join(gap), "border");

  process.stdout.write(`${rowLine(selected.map((column) => color(column.header, "muted")))}\n`);
  process.stdout.write(`${separator}\n`);
  for (const job of jobs) {
    process.stdout.write(`${rowLine([
      job.id,
      color(job.state, stateTone(job.state)),
      color(jobGpuLabel(job), gpuTone(jobGpuLabel(job))),
      job.user,
      compactDuration(job.elapsed),
      color(killCountdownLabel(job), killCountdownTone(job)),
      color(compactEstimateLabel(job), estimateTone(job)),
      job.name
    ])}\n`);
    if (job.reason && job.reason !== "None") {
      process.stdout.write(`  ${color(isPlainOutput() ? "->" : "↳", "muted")} ${color("Reason", "muted")}: ${color(job.reason, "warn")}\n`);
    }
  }
}

async function hydrateJobs(jobs: SlurmJob[]): Promise<SlurmJob[]> {
  if (jobs.length === 0) return jobs;

  return Promise.all(jobs.map(async (job) => {
    try {
      const detail = await getSlurmJob(job.id);
      return {
        ...job,
        name: detail.name !== "-" ? detail.name : job.name,
        user: detail.user !== "-" ? detail.user : job.user,
        state: detail.state !== "-" ? detail.state : job.state,
        partition: detail.partition !== "-" ? detail.partition : job.partition,
        nodes: detail.nodes !== "-" ? detail.nodes : job.nodes,
        elapsed: detail.elapsed !== "-" ? detail.elapsed : job.elapsed,
        timeLimit: detail.timeLimit !== "-" ? detail.timeLimit : job.timeLimit,
        killRemaining: detail.killRemaining,
        killRemainingSeconds: detail.killRemainingSeconds,
        killAt: detail.killAt,
        reason: detail.reason !== "-" ? detail.reason : job.reason,
        slurmReason: detail.slurmReason ?? job.slurmReason,
        taskDescription: detail.taskDescription ?? job.taskDescription,
        tres: detail.tres ?? job.tres,
        gres: detail.gres ?? job.gres,
        workDir: detail.workDir ?? job.workDir,
        command: detail.command ?? job.command
      };
    } catch {
      return job;
    }
  }));
}

function gpuTaskLabel(gpu: GpuStatus): string {
  return gpu.currentTask
    ? `${gpu.currentTask.project} - ${gpu.currentTask.content}`
    : gpu.reservation
      ? `${gpu.reservation.project} - ${gpu.reservation.content}`
      : "-";
}

function gpuOwner(gpu: GpuStatus): string {
  return gpu.currentTask?.user ?? gpu.reservation?.user ?? "-";
}

function printGpuRows(rows: GpuRowData[]): void {
  if (outputMode === "json") {
    printJson(rows);
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(`${color("No GPU rows available.", "muted")}\n`);
    return;
  }

  const compact = terminalWidth() < 96;
  const barWidth = compact ? 6 : 8;
  process.stdout.write(renderTable(
    titleLine("GPU Realtime", gpuSummary(rows)),
    [
      { header: "GPU", min: 3, ideal: 4, align: "right" },
      { header: "State", min: 7, ideal: 10 },
      { header: "Memory", min: 15, ideal: compact ? 17 : 20, grow: 1 },
      { header: "Util", min: 11, ideal: compact ? 13 : 15, grow: 1 },
      { header: "User", min: 6, ideal: 10 },
      { header: "Task", min: 14, ideal: 40, grow: 4, priority: 2 },
      { header: "Model", min: 12, ideal: 26, grow: 2, priority: 5 }
    ],
    rows.map((gpu) => [
      gpu.index,
      color(gpu.state, stateTone(gpu.state)),
      `${usageBar(gpuMemoryPercent(gpu), barWidth)} ${gpuMemoryLabel(gpu)}`,
      `${usageBar(gpu.utilizationPercent, barWidth)} ${gpu.util}`,
      gpu.user,
      gpu.task,
      compactGpuModel(gpu.name)
    ])
  ));
}

function printStatus(status: SystemStatus, source: string): void {
  if (outputMode === "json") {
    printJson({ source, status });
    return;
  }

  printSection(`TensorMesh ${status.serverName}`, `source=${source} updated=${formatDateTime(status.updatedAt)}`);
  if (status.slurm) {
    process.stdout.write(`Slurm: ${status.slurm.available ? color(status.slurm.clusterName ?? "available", "ok") : color(`unavailable (${compactDiagnostic(status.slurm.error)})`, "bad")}\n\n`);
  }
  printGpuRows(status.gpus.map((gpu) => ({
    index: gpu.index,
    name: gpu.name,
    memory: formatMemory(gpu.memoryUsedMb, gpu.memoryTotalMb),
    util: formatPercent(gpu.utilizationPercent),
    memoryUsedMb: gpu.memoryUsedMb,
    memoryTotalMb: gpu.memoryTotalMb,
    utilizationPercent: gpu.utilizationPercent,
    user: gpuOwner(gpu),
    task: gpuTaskLabel(gpu),
    state: stateLabel(gpu.state)
  })));
}

async function printSlurmStatus(allJobs: boolean): Promise<void> {
  const slurm = await getSlurmStatus({ allJobs, user: getCurrentUser() });
  if (!slurm.available) {
    process.stderr.write(`Slurm unavailable: ${compactDiagnostic(slurm.error)}\n`);
    process.stderr.write("Install and configure Slurm, or use tmesh status --api for TensorMesh API fallback.\n");
    process.exitCode = 1;
    return;
  }

  printSection(`Slurm ${slurm.clusterName ?? "cluster"}`, `checked=${formatDateTime(slurm.checkedAt)}`);
  printSlurmNodes(slurm.nodes);
  process.stdout.write("\n");
  printSlurmJobs(slurm.jobs);
}

function printGpu(status: SystemStatus, index: number): void {
  const gpu = status.gpus.find((item) => item.index === index);
  if (!gpu) {
    process.stderr.write(`GPU ${index} was not found.\n`);
    process.exitCode = 1;
    return;
  }

  const lines = [
    `UUID          ${gpu.uuid}`,
    `State         ${stateLabel(gpu.state)}`,
    `Memory        ${formatMemory(gpu.memoryUsedMb, gpu.memoryTotalMb)}`,
    `Utilization   ${formatPercent(gpu.utilizationPercent)}`,
    `Temperature   ${gpu.temperatureC} C`,
    `Power         ${gpu.powerW} W`
  ];

  if (gpu.currentTask) {
    lines.push(
      `Task          ${gpu.currentTask.project} - ${gpu.currentTask.content}`,
      `User          ${gpu.currentTask.user}`,
      `Command       ${gpu.currentTask.command}`
    );
  } else if (gpu.reservation) {
    lines.push(
      `Reservation   ${gpu.reservation.project} - ${gpu.reservation.content}`,
      `User          ${gpu.reservation.user}`,
      `Command       ${gpu.reservation.command}`
    );
  } else {
    lines.push("No active task or reservation.");
  }

  process.stdout.write(renderPanel(`GPU ${gpu.index} ${gpu.name}`, lines));
}

function printUsage(user: string, days: number): void {
  const usage = getMockUsageSummary(user, days);
  if (outputMode === "json") {
    printJson(usage);
    return;
  }

  process.stdout.write(`${titleLine("Usage Summary", `${usage.user}   ${usage.days} days   ${usage.totalCardHours.toFixed(2)} card-hours`)}\n`);
  process.stdout.write(renderTable(
    "Projects",
    [
      { header: "Project", min: 12, ideal: 24, grow: 2 },
      { header: "Hours", min: 7, ideal: 8, align: "right" },
      { header: "Share", min: 16, ideal: 24, grow: 1 }
    ],
    usage.byProject.map((item) => {
      const percent = usage.totalCardHours > 0 ? (item.cardHours / usage.totalCardHours) * 100 : 0;
      return [
        item.project,
        item.cardHours.toFixed(2),
        `${usageBar(percent, terminalWidth() < 84 ? 8 : 14)} ${Math.round(percent)}%`
      ];
    }),
    { maxWidth: 82 }
  ));
}

function printHistory(gpuIndex: number, days: number): void {
  const samples = getMockGpuHistory(gpuIndex, days).slice(-24);
  if (outputMode === "json") {
    printJson({ gpuIndex, days, samples });
    return;
  }

  const memoryTotalMb = Math.max(24576, ...samples.map((sample) => sample.memoryUsedMb));
  process.stdout.write(renderTable(
    `GPU ${gpuIndex} History`,
    [
      { header: "Time", min: 14, ideal: 19, grow: 1 },
      { header: "Memory", min: 13, ideal: 18, grow: 1 },
      { header: "Util", min: 11, ideal: 16, grow: 1 },
      { header: "User", min: 6, ideal: 10 }
    ],
    samples.map((sample) => [
      formatDateTime(sample.timestamp).slice(5),
      `${usageBar((sample.memoryUsedMb / memoryTotalMb) * 100, terminalWidth() < 84 ? 6 : 8)} ${formatMemoryMb(sample.memoryUsedMb)}`,
      `${usageBar(sample.utilizationPercent, terminalWidth() < 84 ? 6 : 8)} ${sample.utilizationPercent}%`,
      sample.user ?? "-"
    ]),
    { maxWidth: 96 }
  ));
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function historyDays(args: string[]): number {
  return Math.min(365, parsePositiveNumber(getFlag(args, "--days"), 14));
}

function historyLimit(args: string[]): number {
  return Math.min(500, parsePositiveInteger(getFlag(args, "--limit"), 50));
}

function parseActiveHistoryFilter(args: string[]): boolean | undefined {
  if (hasFlag(args, "--active") || hasFlag(args, "--running")) return true;
  if (hasFlag(args, "--finished") || hasFlag(args, "--inactive")) return false;
  return undefined;
}

function historyTimeLabel(value: string | undefined): string {
  if (!value) return "-";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  return formatDateTime(value).slice(5, 16);
}

function historyJobGpuLabel(job: SlurmJobHistoryEntry): string {
  return job.allocatedGpuIndexes?.length ? `gpu:${job.allocatedGpuIndexes.join(",")}` : job.gres ?? job.tres ?? "-";
}

function printJobHistory(history: SlurmJobHistory, note?: string): void {
  if (outputMode === "json") {
    printJson(history);
    return;
  }

  if (history.jobs.length === 0) {
    const source = history.source === "api"
      ? "TensorMesh API history"
      : history.source === "sqlite"
        ? "TensorMesh SQLite history"
        : "Slurm accounting";
    process.stdout.write(`${color(`No job history found for ${history.user} in the last ${history.days} day(s).`, "muted")}\n`);
    process.stdout.write(`${color(`Source: ${source}.`, "muted")}\n`);
    if (note) process.stdout.write(`${color(note, "warn")}\n`);
    return;
  }

  const active = history.jobs.filter((job) => job.active).length;
  const subtitle = [
    `${history.jobs.length} shown`,
    `${active} active`,
    `last ${history.days}d`,
    `source ${history.source}`
  ].join("   ");
  process.stdout.write(`${titleLine(`Job History · ${history.user}`, subtitle)}\n`);

  if (terminalWidth() < 88) {
    for (const job of history.jobs) {
      process.stdout.write([
        `${color(`#${job.id}`, "bold")}  ${color(job.state, stateTone(job.state))}  ${historyJobGpuLabel(job)}  ${historyTimeLabel(job.lastSeenAt)}`,
        `  ${job.name}`,
        `  Seen ${historyTimeLabel(job.firstSeenAt)} -> ${historyTimeLabel(job.endedAt ?? job.lastSeenAt)}   Time ${compactDuration(job.elapsed)}`,
        `  Reason ${job.reason && job.reason !== "None" ? color(job.reason, "warn") : color("-", "muted")}`
      ].join("\n") + "\n");
    }
    if (note) process.stdout.write(`${color(note, "warn")}\n`);
    return;
  }

  const columns: TableColumn[] = [
    { header: "JOB", min: 5, ideal: 7, align: "right" },
    { header: "STATE", min: 8, ideal: 12 },
    { header: "GPU", min: 8, ideal: 14, grow: 1 },
    { header: "LAST", min: 11, ideal: 14 },
    { header: "ELAPSED", min: 7, ideal: 10, priority: 2 },
    { header: "NAME", min: 12, ideal: 24, grow: 2 },
    { header: "REASON", min: 14, ideal: 36, grow: 3, priority: 1 }
  ];
  const rows = history.jobs.map((job) => [
    job.id,
    job.state,
    historyJobGpuLabel(job),
    historyTimeLabel(job.lastSeenAt),
    compactDuration(job.elapsed),
    job.name,
    job.reason && job.reason !== "None" ? job.reason : "-"
  ]);
  const layout = layoutColumns(columns, rows);
  const selected = layout.indexes.map((index) => columns[index]);
  const gap = "  ";
  const rowLine = (cells: Array<string | number>) => selected.map((column, offset) => fitCell(cells[layout.indexes[offset]] ?? "-", layout.widths[offset], column.align)).join(gap);
  const separatorChar = isPlainOutput() ? "-" : "─";
  const separator = color(layout.widths.map((width) => separatorChar.repeat(width)).join(gap), "border");

  process.stdout.write(`${rowLine(selected.map((column) => color(column.header, "muted")))}\n`);
  process.stdout.write(`${separator}\n`);
  for (const job of history.jobs) {
    process.stdout.write(`${rowLine([
      job.id,
      color(job.state, stateTone(job.state)),
      color(historyJobGpuLabel(job), gpuTone(historyJobGpuLabel(job))),
      historyTimeLabel(job.lastSeenAt),
      compactDuration(job.elapsed),
      job.name,
      job.reason && job.reason !== "None" ? color(job.reason, "warn") : "-"
    ])}\n`);
  }
  if (note) process.stdout.write(`${color(note, "warn")}\n`);
}

function splitSacctLine(line: string, columns: string[]): SacctJobHistoryRow {
  const values = line.split("|");
  const row: SacctJobHistoryRow = {};
  columns.forEach((column, index) => {
    const value = values[index]?.trim();
    if (value) row[column as keyof SacctJobHistoryRow] = value;
  });
  return row;
}

function normalizeSacctTimestamp(value: string | undefined): string | undefined {
  if (!value || value === "Unknown" || value === "None") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function formatSacctDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function sacctRowToHistoryEntry(row: SacctJobHistoryRow): SlurmJobHistoryEntry | undefined {
  const id = row.JobIDRaw ?? row.JobID;
  if (!id) return undefined;
  const endedAt = normalizeSacctTimestamp(row.End);
  const lastSeenAt = endedAt ?? normalizeSacctTimestamp(row.Start) ?? normalizeSacctTimestamp(row.Submit) ?? new Date().toISOString();
  const state = row.State ?? "-";
  return {
    id,
    name: row.JobName ?? "-",
    user: row.User ?? getCurrentUser(),
    state,
    partition: row.Partition ?? "-",
    nodes: row.NodeList ?? row.AllocNodes ?? "-",
    elapsed: row.Elapsed ?? "-",
    timeLimit: row.Timelimit ?? "-",
    reason: "-",
    comment: row.Comment,
    active: isActiveSlurmJobState(state),
    firstSeenAt: normalizeSacctTimestamp(row.Submit) ?? normalizeSacctTimestamp(row.Start) ?? lastSeenAt,
    lastSeenAt,
    endedAt,
    submittedAt: normalizeSacctTimestamp(row.Submit),
    startedAt: normalizeSacctTimestamp(row.Start),
    exitCode: row.ExitCode,
    tres: row.AllocTRES ?? row.ReqTRES,
    workDir: row.WorkDir
  };
}

function parseJsonNumberList(value: unknown): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : undefined;
  } catch {
    return undefined;
  }
}

function historyEntryFromDbRow(row: Record<string, unknown>): SlurmJobHistoryEntry {
  return {
    id: String(row.id),
    name: String(row.name),
    user: String(row.user),
    state: String(row.state),
    partition: row.partition ? String(row.partition) : "-",
    nodes: row.nodes ? String(row.nodes) : "-",
    elapsed: row.elapsed ? String(row.elapsed) : "-",
    timeLimit: row.timeLimit ? String(row.timeLimit) : "-",
    reason: row.reason ? String(row.reason) : "-",
    slurmReason: row.slurmReason ? String(row.slurmReason) : undefined,
    taskDescription: row.taskDescription ? String(row.taskDescription) : undefined,
    comment: row.comment ? String(row.comment) : undefined,
    notice: Boolean(row.notice),
    estimatedHours: row.estimatedHours == null ? undefined : Number(row.estimatedHours),
    estimatedEndAt: row.estimatedEndAt ? String(row.estimatedEndAt) : undefined,
    estimatedOverdue: Boolean(row.estimatedOverdue),
    allocatedGpuIndexes: parseJsonNumberList(row.allocatedGpuIndexes),
    tres: row.tres ? String(row.tres) : undefined,
    gres: row.gres ? String(row.gres) : undefined,
    workDir: row.workDir ? String(row.workDir) : undefined,
    command: row.command ? String(row.command) : undefined,
    firstSeenAt: String(row.firstSeenAt),
    lastSeenAt: String(row.lastSeenAt),
    endedAt: row.endedAt ? String(row.endedAt) : undefined,
    active: Number(row.active) === 1,
    submittedAt: row.submittedAt ? String(row.submittedAt) : undefined,
    startedAt: row.startedAt ? String(row.startedAt) : undefined,
    exitCode: row.exitCode ? String(row.exitCode) : undefined
  };
}

async function getLocalJobHistory(args: string[]): Promise<SlurmJobHistory | null> {
  const dbPath = envValue("TENSORMESH_DB_PATH") ?? path.join(repoRoot, "data", "tensormesh.db");
  if (!existsSync(dbPath)) return null;

  const user = getCurrentUser();
  const days = historyDays(args);
  const limit = historyLimit(args);
  const active = parseActiveHistoryFilter(args);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const activeValue = active === undefined ? null : active ? 1 : 0;
  try {
    const tableResult = await execFileAsync("sqlite3", [
      "-readonly",
      "-json",
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_history'"
    ], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const tableRows = JSON.parse(tableResult.stdout || "[]") as unknown[];
    if (tableRows.length === 0) return {
      user,
      days,
      limit,
      active,
      source: "sqlite",
      jobs: []
    };

    const queryResult = await execFileAsync("sqlite3", [
      "-readonly",
      "-json",
      "-cmd",
      `.parameter set ?1 ${JSON.stringify(user)}`,
      "-cmd",
      `.parameter set ?2 ${JSON.stringify(cutoff)}`,
      "-cmd",
      `.parameter set ?3 ${activeValue === null ? "null" : activeValue}`,
      "-cmd",
      `.parameter set ?4 ${activeValue === null ? "null" : activeValue}`,
      "-cmd",
      `.parameter set ?5 ${limit}`,
      dbPath,
      `
      SELECT
        job_id AS id,
        name,
        user,
        state,
        partition_name AS partition,
        nodes,
        elapsed,
        time_limit AS timeLimit,
        reason,
        slurm_reason AS slurmReason,
        task_description AS taskDescription,
        comment,
        notice,
        estimated_hours AS estimatedHours,
        estimated_end_at AS estimatedEndAt,
        estimated_overdue AS estimatedOverdue,
        allocated_gpu_indexes AS allocatedGpuIndexes,
        tres,
        gres,
        work_dir AS workDir,
        command,
        first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt,
        ended_at AS endedAt,
        active,
        submitted_at AS submittedAt,
        started_at AS startedAt,
        exit_code AS exitCode
      FROM job_history
      WHERE user = ?1
        AND last_seen_at >= ?2
        AND (?3 IS NULL OR active = ?4)
      ORDER BY last_seen_at DESC
      LIMIT ?5
      `
    ], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024
    });
    const rows = JSON.parse(queryResult.stdout || "[]") as Record<string, unknown>[];
    return {
      user,
      days,
      limit,
      active,
      source: "sqlite",
      jobs: rows.map(historyEntryFromDbRow)
    };
  } catch {
    return null;
  }
}

async function getSacctJobHistory(args: string[]): Promise<SlurmJobHistory> {
  const user = getCurrentUser();
  const days = historyDays(args);
  const limit = historyLimit(args);
  const active = parseActiveHistoryFilter(args);
  const columns = [
    "JobIDRaw",
    "JobID",
    "JobName",
    "User",
    "State",
    "Partition",
    "AllocNodes",
    "NodeList",
    "Elapsed",
    "Timelimit",
    "Submit",
    "Start",
    "End",
    "ExitCode",
    "ReqTRES",
    "AllocTRES",
    "WorkDir",
    "Comment"
  ];
  const start = formatSacctDateTime(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const { stdout } = await execFileAsync("sacct", [
    "--noheader",
    "--parsable2",
    "--allocations",
    "--user",
    user,
    "--starttime",
    start,
    "--format",
    columns.join(",")
  ], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const jobs = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => sacctRowToHistoryEntry(splitSacctLine(line, columns)))
    .filter((job): job is SlurmJobHistoryEntry => Boolean(job))
    .filter((job) => active === undefined || job.active === active)
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
    .slice(0, limit);

  return {
    user,
    days,
    limit,
    active,
    source: "sacct",
    jobs
  };
}

async function printJobHistoryCommand(args: string[]): Promise<void> {
  const hasActiveFilter = hasFlag(args, "--active") || hasFlag(args, "--running");
  const hasFinishedFilter = hasFlag(args, "--finished") || hasFlag(args, "--inactive");
  if (hasActiveFilter && hasFinishedFilter) {
    throw new Error("Use either --active or --finished, not both.");
  }

  if (hasFlag(args, "--gpu")) {
    const gpu = Number(getFlagValue(args, "--gpu") ?? "0");
    const days = historyDays(args);
    printHistory(gpu, days);
    return;
  }

  const apiHistory = hasFlag(args, "--no-api") ? null : await fetchApiJobHistory(args);
  if (apiHistory && apiHistory.jobs.length > 0) {
    printJobHistory(apiHistory);
    return;
  }

  let localHistory: SlurmJobHistory | null = null;
  if (!hasFlag(args, "--no-db")) {
    try {
      localHistory = await getLocalJobHistory(args);
      if (localHistory && localHistory.jobs.length > 0) {
        printJobHistory(localHistory, apiHistory ? "TensorMesh API history has no matching rows; showing local SQLite history." : undefined);
        return;
      }
    } catch {
      localHistory = null;
    }
  }

  let sacctNote: string | undefined;
  try {
    const sacctHistory = await getSacctJobHistory(args);
    if (sacctHistory.jobs.length > 0 || !apiHistory) {
      printJobHistory(sacctHistory, apiHistory ? "TensorMesh API history has no matching rows yet; showing Slurm accounting fallback." : undefined);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? compactDiagnostic(error.message) : String(error);
    sacctNote = `Slurm accounting fallback unavailable: ${message}`;
  }

  if (apiHistory) {
    printJobHistory(apiHistory, sacctNote);
    return;
  }

  if (localHistory) {
    printJobHistory(localHistory, sacctNote);
    return;
  }

  throw new Error(sacctNote ?? `TensorMesh API unavailable (${apiBase}) and Slurm accounting history could not be read.`);
}

function printHelp(): void {
  process.stdout.write(`TensorMesh CLI

Usage:
  tmesh                         Show current Slurm/GPU status
  tmesh tui                     Open terminal UI
  tmesh status                  Show Slurm nodes/jobs, then TensorMesh GPU status if available
  watch -n 2 tmesh status       Refresh a stable status snapshot like watch nvidia-smi
  tmesh status --api            Show TensorMesh API GPU status only
  tmesh nvidia-smi [args...]    Print system-level nvidia-smi output through TensorMesh API
  watch -n 2 tmesh nvidia-smi   Refresh raw nvidia-smi output
  tmesh gpu <index>             Show one GPU
  tmesh run --gpus N [opts] -- COMMAND...
                                Submit a Slurm GPU job as the current Linux user
  tmesh bash --gpus N [opts]    Open an interactive Slurm shell
  tmesh ls                      List TensorMesh tmux interactive sessions
  tmesh open <ID>               Attach an existing TensorMesh tmux session
  tmesh close <ID>              Cancel Slurm job if found, then close the TensorMesh tmux session
  tmesh bind --gpu-indexes IDS [opts]
                                Bind existing external GPU processes into a Slurm lock job
  tmesh reserve --at TIME --gpus N [opts] [-- COMMAND...]
                                Queue a Slurm reservation-like future job
  sudo tmesh share --gpu-indexes IDS [opts] -- COMMAND...
                                Root-only: run a task in parallel on occupied
                                GPUs without cancelling the original task
                                (hidden from TensorMesh status; see help)
  tmesh jobs [--mine]           Show current Slurm jobs, defaults to all users
  tmesh job <jobid>             Show one Slurm job
  tmesh cancel [jobid]          Select and confirm cancellation of one of your Slurm jobs
  tmesh history                 Show your recent job history
  tmesh history --gpu <index>   Show GPU history tail
  tmesh usage --user <name>     Show user card-hours
  tmesh web [--ttl HOURS]       Print a signed LAN web URL for the current SSH user
  tmesh upload [DIR] [--ttl H]  Open a token-protected temporary upload folder (default 6h)
  tmesh notice                  Show mail reminder preference for current user
  tmesh notice config           Configure reminder mail and options
  tmesh notice --test           Send a test reminder mail
  tmesh notice token [--export] Print a signed token for local notice API
  tmesh notice send --content X Send an explicit local-code notice
  tmesh help                    Show help

Output options:
  --json                        Print machine-readable JSON for status/list/detail commands
  --plain, --no-color           Print ASCII output without ANSI colors or Unicode bars.
                                Used automatically when stdout is not a TTY, including watch.

History options:
  --days N                      Look back N days, defaults to 14
  --limit N                     Maximum job rows, defaults to 50
  --active / --finished         Filter active or finished jobs
  --no-api                      Skip TensorMesh API history and try sacct directly
  --no-db                       Skip local TensorMesh SQLite history fallback

Slurm run options:
  --gpus N                      Required GPU count
  --name NAME                   Job name, defaults to tmesh-job
  --time HOURS                  Estimated runtime in hours, e.g. 0.5, 2, 10. Does not kill the job.
  --reason TEXT                 Task description shown in Reason. If omitted in a TTY, TensorMesh prompts in Chinese.
  --description TEXT            Alias for --reason
  --slurm-time HH:MM:SS         Optional hard Slurm time limit, defaults to 7 days, max 90 days
  --begin TIME                  Start time, accepts YYYY-MM-DDTHH:mm, "YYYY-MM-DD HH:mm", or HH:mm
  --gpu-indexes 0,1             Request specific GPU queue lanes, requires matching Slurm typed GRES
  --gpu 2                       Alias for --gpu-indexes 2; use --gpus 2 to request two GPUs
  --cwd DIR                     Working directory, defaults to current directory
  --partition NAME              Slurm partition, defaults to gpu
  --cpus-per-gpu N              CPU cores per requested GPU, defaults to 4
  --mem-per-gpu SIZE            Memory per requested GPU, defaults to 24G
  --output PATH                 Optional Slurm output path, defaults to .tmesh/%j/run.log
  --notice                      Enable configured mail reminders for this job in explicit mode

Interactive tmux:
  tmesh bash uses a dedicated tmux server named tensormesh-<uid> when running in a TTY.
  It does not list or modify your normal tmux sessions. Disable with TENSORMESH_BASH_TMUX=0.
  If current GPUs are insufficient, tmesh bash asks whether to enter tmux and wait.
  --wait skips that prompt and waits in Slurm; --no-wait cancels immediately.

External bind options:
  --gpu-indexes 0,1             Required physical GPU lanes to lock
  --owner USER                  Process owner to watch, defaults to current Linux user
  --pids 123,456                Optional exact PID list to watch instead of owner matching
  --poll SECONDS                Watch interval, defaults to 30
  --idle-grace N                Empty polls before exiting, defaults to 2

Share (root-only parallel GPU sharing):
  sudo tmesh share --gpu-indexes IDS [opts] -- COMMAND...
      Run COMMAND in parallel on GPUs that may already be allocated to someone
      else's Slurm job. The original task is never cancelled; the shared task
      runs outside Slurm in a root systemd scope and is hidden from TensorMesh
      status (the card keeps showing the original user's task).
  --gpu-indexes 0,1             Physical GPUs to share (required)
  --name NAME                   Task name, defaults to tmesh-share
  --reason TEXT                 Human-readable description
  --cwd DIR                     Working directory, defaults to current directory
  --memory 8G                   Optional systemd MemoryMax cap (e.g. 8G, 4096M)
  --cpu-quota 50%               Optional systemd CPUQuota cap (e.g. 50%, 200%)
  --output PATH                 Write stdout/stderr to PATH
  sudo tmesh share --list       List active shared tasks
  sudo tmesh share --cancel ID  Stop a shared task and remove it
  Requires root: run through sudo; the sudo policy (sudoers) decides who may
  use this command.

Environment:
  TENSORMESH_API                API base URL, defaults to http://localhost:4317
  TENSORMESH_NOTICE_TOKEN       Bearer token for calling /api/local-notice from user code
  TENSORMESH_WEB_URL            Web base URL for tmesh web, e.g. http://192.168.1.2:8000
  TENSORMESH_WEB_PORT           Web dev server port, defaults to 8000 for TensorMesh deployment
`);
}

function printNoticeHelp(): void {
  process.stdout.write(`TensorMesh Notice

Usage:
  tmesh notice
      Show current user's reminder mail, mode, and enabled options.

  tmesh notice config
      Configure mail first, then configure reminder options.

  tmesh notice --mail [EMAIL]
      Configure only reminder mail. Omit EMAIL to open the mail prompt.

  tmesh notice --option
      Configure only reminder options.

  tmesh notice --test
      Send a test mail to the configured reminder address.

  tmesh notice token [--export] [--ttl HOURS]
      Print a signed token for user-code local notice API.

  tmesh notice send --title TITLE --content TEXT [--log-file PATH --log-lines N]
      Send one explicit local-code notice through /api/local-notice.

Python API example:
  eval "$(tmesh notice token --export)"

  python - <<'PY'
  import os, requests

  api = os.environ.get("TENSORMESH_API", "http://localhost:4317")
  token = os.environ["TENSORMESH_NOTICE_TOKEN"]
  requests.post(
      f"{api}/api/local-notice",
      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
      json={
          "title": "Metric reached",
          "content": "r1=0.721 exceeded threshold=0.700",
          "logTail": "optional log tail text",
      },
      timeout=10,
  ).raise_for_status()
  PY
`);
}

function readSystemEnv(): Record<string, string> {
  if (!existsSync(systemEnvPath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(systemEnvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    values[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function envValue(name: string): string | undefined {
  return process.env[name] ?? systemEnv[name];
}

function getFlag(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function getFlagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function configureOutputMode(args: string[]): string[] {
  const nextArgs: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      outputMode = "json";
      continue;
    }
    if (arg === "--plain" || arg === "--no-color") {
      outputMode = "plain";
      continue;
    }
    nextArgs.push(arg);
  }
  return nextArgs;
}

function requireFlag(args: string[], name: string): string {
  const value = getFlag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseIntegerList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const indexes = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite);
  return indexes.length > 0 ? indexes : undefined;
}

function firstLanAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function defaultWebBaseUrl(): string {
  const configuredWebUrl = envValue("TENSORMESH_WEB_URL");
  if (configuredWebUrl) return configuredWebUrl.replace(/\/$/, "");
  const apiUrl = new URL(apiBase);
  const port = envValue("TENSORMESH_WEB_PORT") ?? "8000";
  const host = apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1" ? firstLanAddress() : apiUrl.hostname;
  return `${apiUrl.protocol}//${host}:${port}`;
}

function askEditableLine(question: string, defaultValue = ""): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    if (defaultValue) rl.write(defaultValue);
  });
}

function showNoticeTabs(page: "mail" | "option"): void {
  const mail = page === "mail" ? color("[NOTICE MAIL]", "bold") : color("[NOTICE MAIL]", "muted");
  const option = page === "option" ? color("[NOTICE OPTION]", "bold") : color("[NOTICE OPTION]", "muted");
  process.stdout.write(`${mail} ${option}\n`);
}

function readLocalLogTail(filePath: string | undefined, lines: number): string | undefined {
  if (!filePath) return undefined;
  const content = readFileSync(filePath, "utf8");
  const count = Math.max(1, Math.min(500, Math.round(lines)));
  return content.split(/\r?\n/).slice(-count).join("\n").trimEnd();
}

function noticeSendContent(args: string[]): string {
  const explicit = getFlag(args, "--content");
  if (explicit) return explicit;
  const start = args[0] === "send" ? 1 : 0;
  const valueFlags = new Set(["--title", "--content", "--log-tail", "--log-file", "--log-lines"]);
  const skipped = new Set<number>();
  args.forEach((arg, index) => {
    if (valueFlags.has(arg)) {
      skipped.add(index);
      skipped.add(index + 1);
    }
  });
  return args
    .slice(start)
    .filter((arg, offset) => !skipped.has(offset + start) && !arg.startsWith("--"))
    .join(" ");
}

async function configureNoticeMail(settings: NoticeSettings): Promise<NoticeSettings> {
  showNoticeTabs("mail");
  const current = normalizeNoticeSettings(settings);
  const mail = await askEditableLine("提醒邮箱，删除为空后回车清除", current.reminderEmail ?? "");
  const next = await patchNoticeSettings({ reminderEmail: mail || null });
  process.stdout.write(`${color("Saved mail", "ok")}: ${next.reminderEmail ?? "-"}\n`);
  return next;
}

function optionValue(settings: NoticeSettings, item: NoticeOptionItem): boolean {
  return Boolean(settings[item.key]);
}

function drawNoticeOptionScreen(settings: NoticeSettings, cursor: number): void {
  process.stdout.write("\x1b[H\x1b[2J");
  showNoticeTabs("option");
  process.stdout.write(`${color("Space", "muted")} toggle  ${color("Up/Down", "muted")} move  ${color("m", "muted")} mode  ${color("Enter", "muted")} save  ${color("Esc/q", "muted")} abort\n\n`);
  process.stdout.write(`Mode: ${color(noticeModeLabel(settings.noticeMode), settings.noticeMode === "global" ? "warn" : "info")}\n\n`);
  noticeOptions.forEach((item, index) => {
    const pointer = index === cursor ? color(">", "info") : " ";
    const checked = optionValue(settings, item) ? color("[x]", "ok") : color("[ ]", "muted");
    process.stdout.write(`${pointer} ${checked} ${color(item.label, index === cursor ? "bold" : undefined)}  ${color(item.description, "muted")}\n`);
  });
  process.stdout.write(`\nLow GPU: ${settings.lowGpuMinutes}m average < ${settings.lowGpuThreshold}%\n`);
}

async function configureNoticeOptions(initial: NoticeSettings): Promise<NoticeSettings> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printNoticeSettings({ user: initial.user, settings: initial });
    throw new Error("notice option config requires an interactive terminal");
  }

  let draft: NoticeSettings = normalizeNoticeSettings(initial);
  let cursor = 0;

  readline.emitKeypressEvents(process.stdin);
  enterAlternateScreen();
  process.stdin.resume();
  process.stdin.setRawMode(true);
  drawNoticeOptionScreen(draft, cursor);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      leaveAlternateScreen();
    };
    const save = async () => {
      cleanup();
      try {
        const next = await patchNoticeSettings({
          notifyJobFinished: draft.notifyJobFinished,
          notifyReservationStarted: draft.notifyReservationStarted,
          notifyJobOverdue: draft.notifyJobOverdue,
          notifyLowGpu: draft.notifyLowGpu,
          noticeMode: draft.noticeMode,
          lowGpuMinutes: draft.lowGpuMinutes,
          lowGpuThreshold: draft.lowGpuThreshold
        });
        process.stdout.write(`${color("Notice options saved.", "ok")}\n`);
        resolve(next);
      } catch (error) {
        reject(error);
      }
    };
    const abort = () => {
      cleanup();
      reject(new Error("notice config aborted"));
    };
    const onKeypress = (_text: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor + noticeOptions.length - 1) % noticeOptions.length;
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % noticeOptions.length;
      } else if (key.name === "space") {
        const item = noticeOptions[cursor];
        draft = { ...draft, [item.key]: !draft[item.key] };
      } else if (key.name === "m") {
        draft = { ...draft, noticeMode: draft.noticeMode === "explicit" ? "global" : "explicit" };
      } else if (key.name === "left" || key.name === "right") {
        return;
      } else if (key.name === "return") {
        void save();
        return;
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        abort();
        return;
      }
      drawNoticeOptionScreen(draft, cursor);
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function runNoticeCommand(args: string[]): Promise<void> {
  if (args[0] === "help" || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printNoticeHelp();
    return;
  }

  if (hasFlag(args, "--token") || args[0] === "token") {
    const ttlHours = Number(getFlag(args, "--ttl", "12"));
    const token = await createCliToken(Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12);
    if (hasFlag(args, "--export")) {
      process.stdout.write(`export TENSORMESH_NOTICE_TOKEN=${token}\n`);
      process.stdout.write(`export TENSORMESH_API=${apiBase}\n`);
    } else {
      process.stdout.write(`${token}\n`);
    }
    return;
  }

  if (hasFlag(args, "--send") || args[0] === "send") {
    const title = getFlag(args, "--title", "TensorMesh 本地提醒") ?? "TensorMesh 本地提醒";
    const content = noticeSendContent(args);
    if (!content.trim()) throw new Error("--content is required for tmesh notice send");
    const logTail = getFlag(args, "--log-tail") ?? readLocalLogTail(getFlag(args, "--log-file"), Number(getFlag(args, "--log-lines", "24")));
    const result = await apiJson<{ ok: boolean; status: "sent" | "queued"; queuedCount: number; reason?: string }>("/api/local-notice", {
      method: "POST",
      body: JSON.stringify({ title, content, logTail })
    });
    process.stdout.write(`Notice ${result.status}${result.queuedCount ? `, queued=${result.queuedCount}` : ""}${result.reason ? ` (${result.reason})` : ""}\n`);
    return;
  }

  const session = await fetchSessionInfo();

  if (hasFlag(args, "--test")) {
    const result = await sendNoticeTestMail(session.settings.reminderEmail);
    process.stdout.write(result.status === 200 ? `${color("Test mail sent.", "ok")}\n` : `Mail API status ${result.status}\n`);
    return;
  }

  if (hasFlag(args, "--mail")) {
    const directMail = getFlagValue(args, "--mail");
    if (directMail !== undefined) {
      const settings = await patchNoticeSettings({ reminderEmail: directMail });
      process.stdout.write(`Mail: ${settings.reminderEmail ?? "-"}\n`);
      return;
    }
    await configureNoticeMail(session.settings);
    return;
  }

  if (hasFlag(args, "--option")) {
    await configureNoticeOptions(session.settings);
    return;
  }

  if (args[0] === "config") {
    const withMail = await configureNoticeMail(session.settings);
    await configureNoticeOptions(withMail);
    return;
  }

  printNoticeSettings(session);
}

async function printWebUrl(args: string[]): Promise<void> {
  const user = getCurrentUser();
  const ttlHours = Number(getFlag(args, "--ttl", "12"));
  const ttlSeconds = Number.isFinite(ttlHours) && ttlHours > 0 ? Math.round(ttlHours * 3600) : 12 * 3600;
  const token = await createWebToken({ user, ttlSeconds });
  const baseUrl = defaultWebBaseUrl();
  const url = `${baseUrl}/tokens?${encodeURIComponent(token)}`;
  process.stdout.write(`TensorMesh Web for ${user}\n`);
  process.stdout.write(`${url}\n`);
  process.stdout.write(`Expires in ${Math.round(ttlSeconds / 3600 * 10) / 10}h\n`);
  process.stdout.write(`Token key ${getWebTokenSecretPath(user)}\n`);
  if (process.env.TERM_PROGRAM?.toLowerCase().includes("vscode") || process.env.VSCODE_IPC_HOOK_CLI) {
    process.stdout.write("VS Code terminal: Ctrl/Cmd-click the URL above if it does not open automatically.\n");
  }
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) return value.replace(" ", "T");
  if (/^\d{2}:\d{2}$/.test(value)) {
    return `${localDate()}T${value}`;
  }
  return value;
}

function deriveGpuCount(options: string[]): number | undefined {
  const gpuIndexes = parseIntegerList(getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu"));
  if (gpuIndexes?.length) return gpuIndexes.length;
  const gpus = getFlag(options, "--gpus");
  return gpus ? Number(gpus) : undefined;
}

function countGpusInGres(value: string | undefined): number {
  if (!value || value === "-" || value === "(null)") return 0;
  let total = 0;

  for (const raw of value.split(/[,\s]+/)) {
    const part = raw.trim();
    if (!part || part === "-" || part === "(null)") continue;

    let match = part.match(/^gpu:gpu\d+(?::(\d+))?$/);
    if (match) {
      total += Number(match[1] ?? 1);
      continue;
    }

    match = part.match(/^gpu(?::[^:]+)?:(\d+)$/);
    if (match) {
      total += Number(match[1]);
      continue;
    }

    match = part.match(/gres\/gpu[=:](\d+)/);
    if (match) {
      total += Number(match[1]);
    }
  }

  return total;
}

function isGpuAllocatingState(state: string): boolean {
  return /RUNNING|CONFIGURING|COMPLETING|SUSPENDED/i.test(state);
}

function allocatedGpuIndexesFromJobs(jobs: SlurmJob[]): Set<number> {
  const indexes = new Set<number>();
  for (const job of jobs) {
    if (!isGpuAllocatingState(job.state)) continue;
    for (const index of job.allocatedGpuIndexes ?? []) {
      indexes.add(index);
    }
  }
  return indexes;
}

function summarizeGpuAvailability(nodes: SlurmNode[], jobs: SlurmJob[]): {
  total: number;
  allocated: number;
  available: number;
  activeJobs: number;
} {
  const total = nodes.reduce((sum, node) => sum + countGpusInGres(node.gres), 0);
  const activeJobs = jobs.filter((job) => isGpuAllocatingState(job.state));
  const allocated = activeJobs.reduce((sum, job) => {
    const indexedCount = job.allocatedGpuIndexes?.length ?? 0;
    return sum + (indexedCount > 0 ? indexedCount : countGpusInGres(job.gres ?? job.tres));
  }, 0);

  return {
    total,
    allocated,
    available: Math.max(0, total - allocated),
    activeJobs: activeJobs.length
  };
}

function askYesNo(question: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    interface_.question(`${question} ${suffix} `, (answer) => {
      interface_.close();
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultValue);
        return;
      }
      resolve(normalized === "y" || normalized === "yes" || normalized === "是");
    });
  });
}

async function confirmInteractiveGpuWait(options: string[], requestedGpus: number | undefined, gpuIndexes: number[] | undefined): Promise<void> {
  const requested = gpuIndexes?.length || requestedGpus || 0;
  if (!Number.isFinite(requested) || requested <= 0 || hasFlag(options, "--wait")) return;

  const status = await getSlurmStatus({ allJobs: true });
  if (!status.available) return;

  const summary = summarizeGpuAvailability(status.nodes, status.jobs);
  if (summary.total <= 0) return;

  const busyIndexes = allocatedGpuIndexesFromJobs(status.jobs);
  const busyRequestedIndexes = (gpuIndexes ?? []).filter((index) => busyIndexes.has(index));
  const countShortage = requested > summary.available;
  if (!countShortage && busyRequestedIndexes.length === 0) return;

  const details = [
    `当前 GPU 资源不足：请求 ${requested} 张，当前可立即分配 ${summary.available}/${summary.total} 张。`,
    busyRequestedIndexes.length > 0 ? `指定 GPU 已被占用：${busyRequestedIndexes.map((index) => `GPU ${index}`).join(", ")}。` : undefined,
    summary.activeJobs > 0 ? `当前已有 ${summary.activeJobs} 个运行中的 Slurm GPU 任务。` : undefined
  ].filter(Boolean).join("\n");

  if (hasFlag(options, "--no-wait")) {
    process.stdout.write(`${details}\n`);
    throw new TaskCreationCancelledError();
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${details}\n非交互调用将继续提交到 Slurm 排队；如需直接取消，请添加 --no-wait。\n`);
    return;
  }

  const shouldWait = await askYesNo(`${details}\n是否继续进入 tmux 终端等待 Slurm 排队？`, false);
  if (!shouldWait) throw new TaskCreationCancelledError();
}

function commandAfterDoubleDash(args: string[]): { options: string[]; command: string[] } {
  const separator = args.indexOf("--");
  if (separator === -1) {
    return { options: args, command: [] };
  }

  return {
    options: args.slice(0, separator),
    command: args.slice(separator + 1)
  };
}

const taskDescriptionPrompt = "请描述当前任务(示例:盲道-大规模推理)：";

function getTaskDescriptionFlag(options: string[]): string | undefined {
  return getFlag(options, "--reason") ?? getFlag(options, "--description") ?? getFlag(options, "--desc");
}

function normalizeTaskDescriptionInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "exit") throw new TaskCreationCancelledError();
  if (!trimmed) throw new Error("任务描述不能为空。");
  return trimmed.length > 240 ? trimmed.slice(0, 240) : trimmed;
}

function askTaskDescription(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("任务描述是必填项；非交互调用请添加 --reason \"盲道-大规模推理\"。");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw === true;

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
    const cancel = () => {
      cleanup();
      process.stdout.write("\n");
      reject(new TaskCreationCancelledError());
    };
    const redrawPrompt = (message?: string) => {
      if (message) process.stdout.write(`${color(message, "warn")}\n`);
      process.stdout.write(taskDescriptionPrompt);
    };
    const clearValue = () => {
      while (value.length > 0) {
        value = value.slice(0, -1);
        process.stdout.write("\b \b");
      }
    };
    const onKeypress = (text: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }
      if (key.name === "escape") {
        cancel();
        return;
      }
      if (key.name === "return" || key.name === "enter" || text === "\r" || text === "\n") {
        try {
          const description = normalizeTaskDescriptionInput(value);
          cleanup();
          process.stdout.write("\n");
          resolve(description);
        } catch (error) {
          if (error instanceof TaskCreationCancelledError) {
            cancel();
            return;
          }
          process.stdout.write("\n");
          value = "";
          redrawPrompt("任务描述不能为空，请输入文字，或输入 exit / 按 Esc 取消。");
        }
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (key.ctrl && key.name === "u") {
        clearValue();
        return;
      }
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") {
        return;
      }
      if (text && !key.ctrl && !key.meta) {
        value += text;
        process.stdout.write(text);
      }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdout.write(taskDescriptionPrompt);
    process.stdin.on("keypress", onKeypress);
  });
}

async function resolveTaskDescription(options: string[]): Promise<string> {
  const fromFlag = getTaskDescriptionFlag(options);
  if (fromFlag !== undefined) return normalizeTaskDescriptionInput(fromFlag);
  return askTaskDescription();
}

async function runSlurmSubmit(args: string[]): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const { options, command } = commandAfterDoubleDash(normalizedArgs);
  if (hasFlag(options, "--help") || hasFlag(options, "-h")) {
    printHelp();
    return;
  }
  if (command.length === 0) throw new Error("Command is required after --");
  const taskDescription = await resolveTaskDescription(options);
  const gpuIndexes = parseIntegerList(getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu"));
  const gpus = getFlag(options, "--gpus") ? Number(getFlag(options, "--gpus")) : gpuIndexes?.length;
  const result = await submitSlurmJob({
    gpus,
    gpuIndexes,
    name: getFlag(options, "--name", "tmesh-job"),
    time: getFlag(options, "--time", "24"),
    taskDescription,
    notice: hasFlag(options, "--notice"),
    slurmTime: getFlag(options, "--slurm-time"),
    begin: parseDateTime(getFlag(options, "--begin") ?? getFlag(options, "--start")),
    cwd: getFlag(options, "--cwd", process.cwd()),
    partition: getFlag(options, "--partition", "gpu"),
    cpusPerGpu: getFlag(options, "--cpus-per-gpu") ? Number(getFlag(options, "--cpus-per-gpu")) : undefined,
    memPerGpu: getFlag(options, "--mem-per-gpu"),
    output: getFlag(options, "--output"),
    command
  });

  process.stdout.write(`Submitted batch job ${result.jobId}\n`);
  if (result.outputPath) process.stdout.write(`Log: ${result.outputPath.replace("%j", result.jobId)}\n`);
  const estimate = submittedEstimateLine(result);
  if (estimate) process.stdout.write(`${estimate}\n`);
  await printJob(result.jobId);
}

async function reserveSlurmSubmit(args: string[]): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const { options, command } = commandAfterDoubleDash(normalizedArgs);
  const begin = parseDateTime(requireFlag(options, "--at"));
  const gpuIndexes = parseIntegerList(getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu"));
  const gpus = deriveGpuCount(options);
  const taskDescription = await resolveTaskDescription(options);
  const result = await submitSlurmJob({
    gpus,
    gpuIndexes,
    name: getFlag(options, "--name", "tmesh-reserve"),
    time: getFlag(options, "--time", "1"),
    taskDescription,
    notice: hasFlag(options, "--notice"),
    slurmTime: getFlag(options, "--slurm-time"),
    begin,
    cwd: getFlag(options, "--cwd", process.cwd()),
    partition: getFlag(options, "--partition", "gpu"),
    cpusPerGpu: getFlag(options, "--cpus-per-gpu") ? Number(getFlag(options, "--cpus-per-gpu")) : undefined,
    memPerGpu: getFlag(options, "--mem-per-gpu"),
    output: getFlag(options, "--output"),
    command: command.length > 0 ? command : ["bash", "-lc", "echo TensorMesh reservation started; sleep infinity"]
  });

  process.stdout.write(`Reserved batch job ${result.jobId} beginning at ${begin}\n`);
  if (result.outputPath) process.stdout.write(`Log: ${result.outputPath.replace("%j", result.jobId)}\n`);
  const estimate = submittedEstimateLine(result);
  if (estimate) process.stdout.write(`${estimate}\n`);
  await printJob(result.jobId);
}

async function runInteractiveBash(args: string[]): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const { options, command } = commandAfterDoubleDash(normalizedArgs);
  if (hasFlag(options, "--help") || hasFlag(options, "-h")) {
    printHelp();
    return;
  }
  const gpuIndexes = parseIntegerList(getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu"));
  const gpus = getFlag(options, "--gpus") ? Number(getFlag(options, "--gpus")) : gpuIndexes?.length;
  await confirmInteractiveGpuWait(options, gpus, gpuIndexes);
  const taskDescription = await resolveTaskDescription(options);

  const code = await runInteractiveSlurm({
    gpus,
    gpuIndexes,
    name: getFlag(options, "--name", "tmesh-bash"),
    time: getFlag(options, "--time", "24"),
    taskDescription,
    notice: hasFlag(options, "--notice"),
    slurmTime: getFlag(options, "--slurm-time"),
    cwd: getFlag(options, "--cwd", process.cwd()),
    partition: getFlag(options, "--partition", "gpu"),
    cpusPerGpu: getFlag(options, "--cpus-per-gpu") ? Number(getFlag(options, "--cpus-per-gpu")) : undefined,
    memPerGpu: getFlag(options, "--mem-per-gpu"),
    command: command.length > 0 ? command : undefined
  });
  process.exitCode = code;
}

async function printTmeshSessions(): Promise<void> {
  const sessions = await listTmeshTmuxSessions();
  if (outputMode === "json") {
    printJson(sessions);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No TensorMesh interactive sessions found.\n");
    return;
  }

  process.stdout.write(renderTable(
    "TensorMesh Sessions",
    [
      { header: "ID", min: 10, ideal: 18, grow: 1 },
      { header: "Job", min: 5, ideal: 8 },
      { header: "State", min: 8, ideal: 10 },
      { header: "Name", min: 14, ideal: 22, grow: 1 },
      { header: "Reason", min: 16, ideal: 34, grow: 2 },
      { header: "CWD", min: 16, ideal: 40, grow: 2, priority: 2 }
    ],
    sessions.map((session) => [
      session.id,
      session.slurmJobId ?? "-",
      session.attached ? color(`attached(${session.attachedClients})`, "ok") : color("detached", "warn"),
      session.jobName ?? "-",
      session.reason ?? "-",
      session.cwd ?? "-"
    ])
  ));
}

async function openTmeshSession(id: string | undefined): Promise<void> {
  if (!id) throw new Error("session id is required");
  const code = await openTmeshTmuxSession(id);
  process.exitCode = code;
}

async function closeTmeshSession(id: string | undefined, args: string[]): Promise<void> {
  if (!id) throw new Error("session id is required");
  const result = await closeTmeshTmuxSession(id, { cancelSlurm: !hasFlag(args, "--no-cancel") });
  const slurm = result.slurmJobId
    ? result.cancelledSlurmJob
      ? `cancelled Slurm job ${result.slurmJobId}`
      : `Slurm job ${result.slurmJobId} not cancelled${result.cancelError ? `: ${result.cancelError}` : ""}`
    : "no Slurm job id found";
  process.stdout.write(`Closed TensorMesh session ${result.id} (${slurm}).\n`);
}

async function releaseTmeshSession(id: string | undefined): Promise<void> {
  if (!id) throw new Error("session id is required");
  const result = await releaseTmeshTmuxSessionIfUnused(id);
  if (outputMode === "json") {
    printJson(result);
    return;
  }
  if (result.released) {
    process.stdout.write(`Released TensorMesh session ${result.id}${result.cancelledSlurmJob && result.slurmJobId ? ` and cancelled Slurm job ${result.slurmJobId}` : ""}.\n`);
  } else {
    process.stdout.write(`TensorMesh session ${result.id} kept: ${result.reason ?? "not eligible"}.\n`);
  }
}

function buildExternalBindCommand(options: string[]): string[] {
  const owner = getFlag(options, "--owner", getCurrentUser()) ?? getCurrentUser();
  const pids = getFlag(options, "--pids");
  const poll = Number(getFlag(options, "--poll", "30"));
  const idleGrace = Number(getFlag(options, "--idle-grace", "2"));
  const command = [
    "/usr/bin/python3",
    externalGpuBindScript,
    "--owner",
    owner,
    "--poll",
    String(Number.isFinite(poll) && poll > 0 ? poll : 30),
    "--idle-grace",
    String(Number.isInteger(idleGrace) && idleGrace > 0 ? idleGrace : 2),
  ];
  if (pids) command.push("--pids", pids);
  return command;
}

async function bindExternalGpu(args: string[]): Promise<void> {
  const options = args[0] === "--" ? args.slice(1) : args;
  if (hasFlag(options, "--help") || hasFlag(options, "-h")) {
    printHelp();
    return;
  }

  const gpuIndexes = parseIntegerList(getFlag(options, "--gpu-indexes") ?? getFlag(options, "--gpu"));
  if (!gpuIndexes?.length) throw new Error("--gpu-indexes is required for tmesh bind");
  const taskDescription = await resolveTaskDescription(options);
  const owner = getFlag(options, "--owner", getCurrentUser()) ?? getCurrentUser();
  const result = await submitSlurmJob({
    gpus: gpuIndexes.length,
    gpuIndexes,
    name: getFlag(options, "--name", `${owner}-external-gpu-bind`),
    time: getFlag(options, "--time", "168"),
    taskDescription,
    slurmTime: getFlag(options, "--slurm-time"),
    cwd: getFlag(options, "--cwd", process.cwd()),
    partition: getFlag(options, "--partition", "gpu"),
    cpusPerGpu: getFlag(options, "--cpus-per-gpu") ? Number(getFlag(options, "--cpus-per-gpu")) : 1,
    memPerGpu: getFlag(options, "--mem-per-gpu", "1G"),
    output: getFlag(options, "--output"),
    command: buildExternalBindCommand(options)
  });

  process.stdout.write(`Bound external GPU usage with Slurm job ${result.jobId}\n`);
  if (result.outputPath) process.stdout.write(`Log: ${result.outputPath.replace("%j", result.jobId)}\n`);
  const estimate = submittedEstimateLine(result);
  if (estimate) process.stdout.write(`${estimate}\n`);
  await printJob(result.jobId);
}

async function printJobs(args: string[]): Promise<void> {
  const mineOnly = hasFlag(args, "--mine") && !hasFlag(args, "--all");
  const jobs = await getSlurmJobs({ all: !mineOnly, user: getCurrentUser() });
  printSlurmJobs(await hydrateJobs(jobs));
}

async function printJob(jobId: string): Promise<void> {
  const job = await getSlurmJob(jobId);
  if (outputMode === "json") {
    printJson(job);
    return;
  }

  process.stdout.write(renderFieldPanel(`Slurm Job ${job.id}`, [
    { label: "Name", value: job.name, tone: "bold" },
    { label: "User", value: job.user, tone: "info" },
    { label: "State", value: job.state, tone: stateTone(job.state) },
    { label: "Partition", value: job.partition, tone: "muted" },
    { label: "Nodes", value: job.nodes, tone: "info" },
    { label: "Elapsed", value: job.elapsed, tone: "muted" },
    { label: "Hard limit", value: job.timeLimit, tone: "muted" },
    { label: "Kill in", value: killCountdownLabel(job), tone: killCountdownTone(job) },
    { label: "Kill at", value: job.killAt ? formatDateTime(job.killAt) : "-", tone: killCountdownTone(job) },
    { label: "Estimate", value: estimateLabel(job), tone: estimateTone(job) },
    { label: "Notice", value: job.notice ? "enabled" : "off", tone: job.notice ? "ok" : "muted" },
    { label: "TRES", value: job.tres ?? "-", tone: "muted" },
    { label: "GRES", value: job.gres ?? "-", tone: gpuTone(job.gres) },
    { label: "WorkDir", value: job.workDir ?? "-", tone: "muted" },
    { label: "Command", value: job.command ?? "-", tone: "muted" },
    { label: "Reason", value: job.reason, tone: job.reason === "None" ? "muted" : "warn" }
  ]));
}

async function printModernStatus(allJobs: boolean): Promise<void> {
  const [slurm, apiStatus, gpuRows] = await Promise.all([
    getSlurmStatus({ allJobs, user: getCurrentUser() }),
    fetchApiStatus(),
    getRealGpuRows()
  ]);

  if (outputMode === "json") {
    printJson({
      user: getCurrentUser(),
      apiBase,
      checkedAt: new Date().toISOString(),
      slurm,
      apiStatus,
      gpuRows
    });
    return;
  }

  process.stdout.write(renderPanel("TensorMesh CLI", [
    `User       ${getCurrentUser()}`,
    `Time       ${formatDateTime(new Date())}`,
    `API        ${apiBase}`,
    `Terminal   ${terminalWidth()} columns`
  ]));
  process.stdout.write("\n");

  if (slurm.available) {
    printSection(`Slurm ${slurm.clusterName ?? "cluster"}`);
    printSlurmNodes(slurm.nodes);
    process.stdout.write("\n");
    printSlurmJobs(await hydrateJobs(slurm.jobs));
    process.stdout.write("\n");
  } else {
    process.stdout.write(`${color(`Slurm unavailable: ${compactDiagnostic(slurm.error)}`, "bad")}\n\n`);
  }

  if (gpuRows.length > 0) {
    printSection("GPU 实时状态", "nvidia-smi");
    printGpuRows(gpuRows);
    return;
  }

  if (apiStatus) {
    printStatus(apiStatus, "api");
    return;
  }

  process.stdout.write(`${color(`No live GPU status available. ${apiBase} is unreachable and local nvidia-smi may be blocked by GPU isolation. Start TensorMesh API outside the isolated user.`, "warn")}\n`);
}

async function printNvidiaSmi(args: string[]): Promise<void> {
  const result = await fetchApiNvidiaSmi(args) ?? await runNvidiaSmi(args);
  if (outputMode === "json") {
    printJson(result);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[H");
}

function leaveAlternateScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

function renderTui(status: SystemStatus, source: string): void {
  clearScreen();
  process.stdout.write("TensorMesh GPU Console\n");
  process.stdout.write(`Server: ${status.serverName}   Source: ${source}   User: ${process.env.USER ?? "unknown"}\n`);
  process.stdout.write(`Updated: ${new Date(status.updatedAt).toLocaleString()}\n\n`);
  process.stdout.write(
    `${pad("GPU", 6)}${pad("Mem Used", 16)}${pad("Util", 8)}${pad("User", 12)}${pad("Task", 34)}Status\n`
  );
  process.stdout.write(`${"-".repeat(86)}\n`);

  for (const gpu of status.gpus) {
    const owner = gpu.currentTask?.user ?? gpu.reservation?.user ?? "-";
    const task = gpu.currentTask
      ? `${gpu.currentTask.project} - ${gpu.currentTask.content}`
      : gpu.reservation
        ? `${gpu.reservation.project} - ${gpu.reservation.content}`
        : "-";
    process.stdout.write(
      `${pad(gpu.index, 6)}${pad(formatMemory(gpu.memoryUsedMb, gpu.memoryTotalMb), 16)}${pad(
        formatPercent(gpu.utilizationPercent),
        8
      )}${pad(owner, 12)}${pad(task, 34)}${stateLabel(gpu.state)}\n`
    );
  }

  process.stdout.write("\n[Enter] Refresh  [r] Register  [b] Reserve  [u] Usage  [q] Quit\n");
}

async function runTui(): Promise<void> {
  let current = await getStatus();
  renderTui(current.status, current.source);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on("keypress", async (_text, key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      process.stdout.write("\n");
      process.exit(0);
    }

    if (key.name === "return") {
      current = await getStatus();
      renderTui(current.status, current.source);
      return;
    }

    if (key.name === "r") {
      renderTui(current.status, current.source);
      process.stdout.write("\nUse command mode: tmesh run --gpus N -- COMMAND...\n");
      return;
    }

    if (key.name === "b") {
      renderTui(current.status, current.source);
      process.stdout.write("\nUse command mode: tmesh reserve --at HH:mm --gpus N -- COMMAND...\n");
      return;
    }

    if (key.name === "u") {
      renderTui(current.status, current.source);
      printUsage(process.env.USER ?? "alice", 14);
    }
  });
}

async function main(): Promise<void> {
  const args = configureOutputMode(process.argv.slice(2));
  const command = args[0] ?? "status";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "tui") {
    await runTui();
    return;
  }

  if (command === "status") {
    if (hasFlag(args, "--api")) {
      const { status, source } = await getStatus();
      printStatus(status, source);
      return;
    }
    await printModernStatus(hasFlag(args, "--all"));
    return;
  }

  if (command === "nvidia-smi" || command === "smi") {
    await printNvidiaSmi(args.slice(1));
    return;
  }

  if (command === "gpu") {
    const index = Number(args[1] ?? 0);
    const { status } = await getStatus();
    printGpu(status, index);
    return;
  }

  if (command === "history") {
    await printJobHistoryCommand(args.slice(1));
    return;
  }

  if (command === "usage") {
    const user = getFlag(args, "--user", process.env.USER ?? "alice") ?? "alice";
    const days = Number(getFlag(args, "--days", "14"));
    printUsage(user, days);
    return;
  }

  if (command === "web") {
    await printWebUrl(args.slice(1));
    return;
  }

  if (command === "upload") {
    await runUploadCommand(args.slice(1), {
      webBaseUrl: defaultWebBaseUrl()
    });
    return;
  }

  if (command === "notice") {
    await runNoticeCommand(args.slice(1));
    return;
  }

  if (command === "run") {
    await runSlurmSubmit(args.slice(1));
    return;
  }

  if (command === "bash") {
    await runInteractiveBash(args.slice(1));
    return;
  }

  if (command === "ls") {
    await printTmeshSessions();
    return;
  }

  if (command === "open") {
    await openTmeshSession(args[1]);
    return;
  }

  if (command === "close") {
    await closeTmeshSession(args[1], args.slice(2));
    return;
  }

  if (command === "__release-tmux") {
    await releaseTmeshSession(args[1]);
    return;
  }

  if (command === "bind") {
    await bindExternalGpu(args.slice(1));
    return;
  }

  if (command === "reserve") {
    await reserveSlurmSubmit(args.slice(1));
    return;
  }

  if (command === "share") {
    const sub = args.slice(1);
    if (hasFlag(sub, "--list")) {
      await listSharedTasks();
      return;
    }
    if (hasFlag(sub, "--cancel")) {
      const id = getFlag(sub, "--cancel");
      if (!id) throw new Error("tmesh share --cancel requires a shared task id");
      await cancelSharedTask(id);
      return;
    }
    await runSharedTask(sub);
    return;
  }

  if (command === "jobs") {
    await printJobs(args.slice(1));
    return;
  }

  if (command === "job") {
    const jobId = args[1];
    if (!jobId) throw new Error("job id is required");
    await printJob(jobId);
    return;
  }

  if (command === "cancel") {
    if (args.length > 2) throw new Error("Usage: tmesh cancel [jobid]");
    const cancelledJob = await runCancelCommand(args[1], {
      currentUser: getCurrentUser(),
      getJobs: (user) => getSlurmJobs({ all: false, user }),
      getJob: getSlurmJob,
      cancelJob: cancelSlurmJob,
      selectJob: selectCancelJob,
      confirmJob: confirmCancelJob
    });
    if (!cancelledJob) {
      process.stdout.write("Cancellation aborted; no job was cancelled.\n");
      process.exitCode = 130;
      return;
    }
    process.stdout.write(`Cancelled job ${cancelledJob.id}\n`);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof TaskCreationCancelledError) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (message.includes("TensorMesh API 不可访问")) {
    process.stderr.write(`当前 API: ${apiBase}\n`);
    process.stderr.write("可检查: systemctl status tensormesh-api --no-pager 或设置 TENSORMESH_API=http://host:4317\n");
  }
  process.exitCode = 1;
});
