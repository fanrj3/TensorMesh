import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import {
  type GpuProcess,
  type Reservation,
  type SlurmJob,
  type Task,
  getMockSystemStatus,
  type SystemStatus
} from "@tensormesh/shared";
import {
  cancelSlurmJob,
  getSlurmJob,
  getSlurmStatus,
  getTmeshTmuxAccessForUser,
  getTmeshTmuxSessionSnapshot,
  isSlurmJobSuppressed,
  listTmeshTmuxSessions,
  runNvidiaSmi,
  sendTmeshTmuxSessionInput,
  verifyWebToken,
  type TmeshTmuxSession
} from "@tensormesh/shared/node";
import {
  consumeLocalNoticeQuota,
  createReservation,
  createTask,
  enqueueLocalNotice,
  finishTask,
  getActiveSlurmJobHistoryIds,
  getActiveReservations,
  getActiveTasks,
  getAllUserSettings,
  getAverageGpuUtilization,
  getDatabaseInfo,
  getGpuHistoryFromDb,
  getKnownUsers,
  getLocalNoticeQuotaLimit,
  getMidnightRows,
  getQueuedLocalNoticeCount,
  getQueuedLocalNotices,
  getSlurmJobHistoryFromDb,
  getUserSettings,
  hasNotificationEvent,
  markLocalNoticesDelivered,
  getUsageSummaryFromDb,
  pruneHistory,
  pruneSlurmJobHistory,
  recordSlurmJobHistory,
  recordStatusSamples,
  recordNotificationEvent,
  updateUserSettings,
  type LocalNoticeInput,
  type QueuedLocalNotice,
  type UserSettings
} from "./db";
import { getMailConfigInfo, renderTensorMeshMail, sendCloudMail } from "./mail";
import { collectCpuStatus, collectNvidiaStatus } from "./nvidia";
import {
  listSharedTasks,
  registerSharedTask,
  unregisterSharedTask,
} from "./shared-tasks";

/**
 * Server-side gate for shared (borrowed) GPU tasks: only root may register or
 * unregister shared tasks. The CLI only allows `sudo tmesh share`, so the
 * token user is "root" in practice; this check enforces the same rule for
 * direct API callers.
 */
function isShareAdminUser(user: string): boolean {
  return user === "root";
}

const port = Number(process.env.TENSORMESH_PORT ?? process.env.PORT ?? 4317);
const host = process.env.TENSORMESH_HOST ?? "0.0.0.0";
const collectIntervalMs = Number(process.env.TENSORMESH_COLLECT_INTERVAL_MS ?? 10_000);
const jobHistoryRetentionDays = Number(process.env.TENSORMESH_JOB_HISTORY_RETENTION_DAYS ?? 240);
const webPort = process.env.TENSORMESH_WEB_PORT ?? "8000";
const webUrlBase = process.env.TENSORMESH_WEB_URL ?? `http://${host === "0.0.0.0" ? os.hostname() : host}:${webPort}`;

type RuntimeStatus = SystemStatus & {
  collector?: {
    source: "nvidia-smi" | "mock" | "unavailable";
    reason?: string;
  };
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

let latestStatus: RuntimeStatus | null = null;
let latestCollectPromise: Promise<RuntimeStatus> | null = null;
let previousSlurmJobs = new Map<string, SlurmJob>();
let detailedSlurmJobs = new Map<string, SlurmJob>();
let notificationPromise: Promise<void> | null = null;
let localNoticeFlushPromise: Promise<void> | null = null;

const slurmTaskStartedAt = new Map<string, string>();

async function hydrateSlurmStatus(slurm: NonNullable<RuntimeStatus["slurm"]>): Promise<NonNullable<RuntimeStatus["slurm"]>> {
  if (!slurm.available || slurm.jobs.length === 0) return slurm;
  const jobs = await Promise.all(slurm.jobs.map((job) => getSlurmJob(job.id).catch(() => job)));
  return {
    ...slurm,
    jobs
  };
}

async function recordObservedSlurmJobHistory(jobs: SlurmJob[], observedAt: string): Promise<void> {
  const currentIds = new Set(jobs.map((job) => job.id));
  const missingIds = getActiveSlurmJobHistoryIds().filter((id) => !currentIds.has(id));
  const finalizedJobs = (await Promise.all(
    missingIds.map((id) => getSlurmJob(id).catch(() => null))
  )).filter((job): job is SlurmJob => job !== null);
  recordSlurmJobHistory([...jobs, ...finalizedJobs], observedAt);
}

interface RequestSession {
  user: string;
  token: string;
  expiresAt: string;
}

function getRequestToken(url: URL, request: IncomingMessage): string | undefined {
  const queryToken = url.searchParams.get("token") ?? url.searchParams.get("t");
  if (queryToken) return queryToken;
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (rawQuery && !rawQuery.includes("=")) return decodeURIComponent(rawQuery);

  const auth = request.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isWebProxyRequest(request: IncomingMessage): boolean {
  return request.headers["x-tensormesh-web-proxy"] === "1";
}

async function getRequestSession(url: URL, request: IncomingMessage): Promise<RequestSession | null> {
  const token = getRequestToken(url, request);
  const payload = await verifyWebToken(token);
  if (payload) {
    return {
      user: payload.user,
      token: token ?? "",
      expiresAt: payload.expiresAt
    };
  }

  if (!isWebProxyRequest(request) && isLoopbackAddress(request.socket.remoteAddress)) {
    return {
      user: process.env.USER ?? "local",
      token: "",
      expiresAt: ""
    };
  }

  return null;
}

function requireSession(session: RequestSession | null): RequestSession {
  if (!session) throw new HttpError(401, "valid TensorMesh web token is required");
  return session;
}

function requireSignedSession(session: RequestSession | null): RequestSession {
  const current = requireSession(session);
  if (!current.token) throw new HttpError(401, "signed TensorMesh token is required");
  return current;
}

function jsonResponse(body: unknown, status = 200): ResponseInit {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    },
    body: JSON.stringify(body, null, 2)
  };
}

interface ResponseInit {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function getQueryNumber(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getQueryDate(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function getQueryBoolean(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name)?.trim().toLowerCase();
  if (!value || value === "all") return undefined;
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return undefined;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function requireNonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBodyBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function optionalNoticeMode(value: unknown): "explicit" | "global" | undefined {
  return value === "explicit" || value === "global" ? value : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n... truncated by TensorMesh ...`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseGpuIndexes(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function csvResponse(filename: string, rows: Array<Record<string, unknown>>, columns: string[]): ResponseInit {
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = `\ufeff${[columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n")}`;

  return {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    },
    body
  };
}

function htmlTableResponse(title: string, rows: Array<Record<string, unknown>>, columns: string[]): ResponseInit {
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#090909}
    h1{font-size:22px;font-weight:600;margin:0 0 16px}
    table{border-collapse:collapse;width:100%;font-size:13px}
    th,td{border:1px solid #e5e5e5;padding:8px 10px;text-align:left;vertical-align:top}
    th{background:#fafafa;font-weight:600}
    tr:nth-child(even) td{background:#fcfcfc}
    .empty{padding:20px;border:1px solid #e5e5e5;border-radius:8px;color:#737373}
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${
    rows.length === 0
      ? '<div class="empty">没有可导出的数据</div>'
      : `<table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
  }
</body>
</html>`;

  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    },
    body
  };
}

function normalizeTokenUrl(url: URL): string {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const token = url.searchParams.get("token") ?? url.searchParams.get("t") ?? (rawQuery && !rawQuery.includes("=") ? decodeURIComponent(rawQuery) : "");
  if (!token) return "/";
  return `/?token=${encodeURIComponent(token)}`;
}

function tokenRedirect(url: URL): ResponseInit {
  return {
    status: 302,
    headers: {
      location: normalizeTokenUrl(url),
      "cache-control": "no-store"
    },
    body: ""
  };
}

function getSafeLogPath(jobId: string, job?: { workDir?: string }): string | null {
  if (!/^\d+$/.test(jobId)) return null;
  const workDir = job?.workDir;
  const candidates = [
    workDir ? path.join(workDir, ".tmesh", jobId, "run.log") : undefined,
    workDir ? path.join(workDir, ".tmesh", jobId, "submit.log") : undefined,
    workDir ? path.join(workDir, ".tmesh", jobId, "bash.log") : undefined,
    path.join(process.cwd(), ".tmesh", jobId, "run.log"),
    path.join(process.cwd(), ".tmesh", jobId, "submit.log"),
    path.join(process.cwd(), ".tmesh", jobId, "bash.log")
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function readLogTail(filePath: string, maxBytes: number): Promise<string> {
  const content = await readFile(filePath);
  return content.subarray(Math.max(0, content.length - maxBytes)).toString("utf8");
}

function findTmeshSessionForRequest(sessions: TmeshTmuxSession[], id: string): TmeshTmuxSession | undefined {
  const decoded = decodeURIComponent(id);
  return sessions.find((session) =>
    session.id === decoded ||
    session.name === decoded ||
    session.slurmJobId === decoded ||
    session.initialName === decoded
  );
}

async function assertTmeshSessionOwner(session: TmeshTmuxSession, user: string): Promise<void> {
  if (session.owner) {
    if (session.owner !== user) throw new Error("only the session owner can access this TensorMesh shell");
    return;
  }
  if (!session.slurmJobId) throw new Error("TensorMesh session owner is not ready");
  const job = await getSlurmJob(session.slurmJobId);
  if (job.user !== user) throw new Error("only the session owner can access this TensorMesh shell");
}

async function listUserTmeshSessions(user: string): Promise<TmeshTmuxSession[]> {
  const access = getTmeshTmuxAccessForUser(user);
  const sessions = await listTmeshTmuxSessions(access);
  const owned: TmeshTmuxSession[] = [];
  for (const session of sessions) {
    try {
      await assertTmeshSessionOwner(session, user);
      owned.push(session);
    } catch {
      // Hide sessions that are not owned by this token user.
    }
  }
  return owned;
}

function parseGpuIndexesFromGres(gres: string | undefined): number[] {
  if (!gres) return [];
  const indexes = new Set<number>();
  for (const match of gres.matchAll(/gpu(?:[:=]gpu)?(\d+)/g)) {
    indexes.add(Number(match[1]));
  }
  return Array.from(indexes).filter(Number.isFinite).sort((a, b) => a - b);
}

async function readJobLogTail(job: SlurmJob): Promise<string | undefined> {
  const logPath = getSafeLogPath(job.id, job);
  if (!logPath) return undefined;
  const content = await readLogTail(logPath, 128 * 1024).catch(() => "");
  const lines = content.split("\n").slice(-24).join("\n").trimEnd();
  return lines || undefined;
}

async function sendJobNotification(input: {
  eventKey: string;
  eventType: string;
  job: SlurmJob;
  title: string;
  summaryLabel: string;
  summaryValue: string;
  body: string;
  notice: string;
  details?: Array<{ label: string; value: string; monospace?: boolean }>;
  includeLog?: boolean;
}): Promise<void> {
  if (hasNotificationEvent(input.eventKey)) return;
  const settings = getUserSettings(input.job.user);
  if (!settings.reminderEmail) return;

  try {
    const logTail = input.includeLog ? await readJobLogTail(input.job) : undefined;
    await sendCloudMail({
      toName: input.job.user,
      toMail: settings.reminderEmail,
      subject: `TensorMesh ${input.title}`,
      isHtml: true,
      content: renderTensorMeshMail({
        title: input.title,
        recipientName: input.job.user,
        body: input.body,
        summaryLabel: input.summaryLabel,
        summaryValue: input.summaryValue,
        details: [
          { label: "Job", value: input.job.id, monospace: true },
          { label: "名称", value: input.job.name },
          { label: "GPU", value: input.job.gres ?? "-" },
          { label: "工作目录", value: input.job.workDir ?? "-", monospace: true },
          ...(input.details ?? [])
        ],
        notice: input.notice,
        logTail
      })
    });
    recordNotificationEvent({
      eventKey: input.eventKey,
      user: input.job.user,
      jobId: input.job.id,
      eventType: input.eventType,
      status: "sent"
    });
  } catch (error) {
    recordNotificationEvent({
      eventKey: input.eventKey,
      user: input.job.user,
      jobId: input.job.id,
      eventType: input.eventType,
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function shouldSendJobNotification(settings: UserSettings | undefined, job: SlurmJob | undefined): boolean {
  if (!settings || !job) return false;
  return settings.noticeMode === "global" || Boolean(job.notice);
}

function localNoticeDetails(user: string, extra: Array<{ label: string; value: string; monospace?: boolean }> = []) {
  return [
    { label: "TensorMesh 用户", value: user },
    { label: "触发时间", value: new Date().toISOString(), monospace: true },
    ...extra
  ];
}

async function sendLocalNoticeMail(input: {
  user: string;
  settings: UserSettings;
  title: string;
  content: string;
  logTail?: string;
  details?: Array<{ label: string; value: string; monospace?: boolean }>;
}): Promise<void> {
  if (!input.settings.reminderEmail) throw new Error("Set a reminder email before sending local notices");
  await sendCloudMail({
    toName: input.user,
    toMail: input.settings.reminderEmail,
    subject: `TensorMesh ${input.title}`,
    isHtml: true,
    content: renderTensorMeshMail({
      title: input.title,
      recipientName: input.user,
      body: input.content,
      summaryLabel: "通知来源",
      summaryValue: "Local API",
      details: localNoticeDetails(input.user, input.details),
      notice: "这封邮件由用户代码通过 TensorMesh 本地通知 API 显式触发。超出配额的通知会排队，并在配额恢复后汇总发送。",
      logTail: input.logTail
    })
  });
}

async function handleLocalNotice(input: LocalNoticeInput): Promise<{ status: "sent" | "queued"; queuedCount: number; reason?: string }> {
  const settings = getUserSettings(input.user);
  if (!settings.reminderEmail) throw new Error("Set a reminder email before sending local notices");

  const backlog = getQueuedLocalNoticeCount(input.user);
  if (backlog > 0 || !consumeLocalNoticeQuota(input.user)) {
    enqueueLocalNotice(input);
    return { status: "queued", queuedCount: getQueuedLocalNoticeCount(input.user), reason: backlog > 0 ? "backlog" : "quota" };
  }

  try {
    await sendLocalNoticeMail({
      user: input.user,
      settings,
      title: input.title,
      content: input.content,
      logTail: input.logTail
    });
    return { status: "sent", queuedCount: getQueuedLocalNoticeCount(input.user) };
  } catch (error) {
    enqueueLocalNotice(input);
    return {
      status: "queued",
      queuedCount: getQueuedLocalNoticeCount(input.user),
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendQueuedLocalNotices(user: string, settings: UserSettings, notices: QueuedLocalNotice[]): Promise<void> {
  const lines = notices.flatMap((notice, index) => [
    `#${index + 1} ${notice.title}`,
    `time=${notice.createdAt}`,
    notice.content,
    ...(notice.logTail ? ["", "log tail:", notice.logTail] : []),
    ""
  ]);
  await sendCloudMail({
    toName: user,
    toMail: settings.reminderEmail ?? "",
    subject: `TensorMesh 本地代码提醒汇总 (${notices.length})`,
    isHtml: true,
    content: renderTensorMeshMail({
      title: "本地代码提醒汇总",
      recipientName: user,
      body: `配额恢复后，TensorMesh 汇总发送了 ${notices.length} 条此前排队的本地代码提醒。`,
      summaryLabel: "汇总数量",
      summaryValue: `${notices.length} 条`,
      details: localNoticeDetails(user, [
        { label: "配额窗口", value: `每 30 分钟 ${getLocalNoticeQuotaLimit()} 封` },
        { label: "最早排队", value: notices[0]?.createdAt ?? "-", monospace: true }
      ]),
      notice: "折叠区包含本次汇总的提醒内容和附带日志尾部。后续通知仍受每用户配额限制。",
      logTail: lines.join("\n").trimEnd()
    })
  });
}

async function flushQueuedLocalNotices(): Promise<void> {
  if (localNoticeFlushPromise) return localNoticeFlushPromise;
  localNoticeFlushPromise = (async () => {
    for (const settings of getAllUserSettings()) {
      if (!settings.reminderEmail) continue;
      const notices = getQueuedLocalNotices(settings.user, 50);
      if (notices.length === 0) continue;
      if (!consumeLocalNoticeQuota(settings.user)) continue;
      try {
        await sendQueuedLocalNotices(settings.user, settings, notices);
        markLocalNoticesDelivered(notices.map((notice) => notice.id));
      } catch {
        // Keep queued rows for a later quota window.
      }
    }
  })().finally(() => {
    localNoticeFlushPromise = null;
  });
  return localNoticeFlushPromise;
}

async function evaluateNotifications(status: RuntimeStatus): Promise<void> {
  if (notificationPromise) return notificationPromise;
  notificationPromise = evaluateNotificationsOnce(status).finally(() => {
    notificationPromise = null;
  });
  return notificationPromise;
}

async function evaluateNotificationsOnce(status: RuntimeStatus): Promise<void> {
  const jobs = status.slurm?.jobs ?? [];
  const currentJobs = new Map(jobs.map((job) => [job.id, job]));
  const nextDetailedJobs = new Map<string, SlurmJob>();
  const settingsByUser = new Map(getAllUserSettings().map((settings) => [settings.user, settings]));

  const getDetailedJob = async (job: SlurmJob) => {
    const cached = detailedSlurmJobs.get(job.id);
    const detail = cached ?? await getSlurmJob(job.id).catch(() => job);
    nextDetailedJobs.set(job.id, detail);
    return detail;
  };

  for (const previous of previousSlurmJobs.values()) {
    if (currentJobs.has(previous.id)) continue;
    const settings = settingsByUser.get(previous.user);
    if (!settings?.notifyJobFinished || !settings.reminderEmail) continue;
    if (await isSlurmJobSuppressed(previous.id)) continue;
    if (/CANCEL|FAILED|TIMEOUT|NODE_FAIL|PREEMPT/i.test(previous.state)) continue;
    const detail = detailedSlurmJobs.get(previous.id) ?? previous;
    if (!shouldSendJobNotification(settings, detail)) continue;
    await sendJobNotification({
      eventKey: `job-finished:${previous.id}`,
      eventType: "job-finished",
      job: detail,
      title: "Job 已自然完成",
      summaryLabel: "完成任务",
      summaryValue: previous.name || `Job ${previous.id}`,
      body: "你的 TensorMesh/Slurm 任务已经自然完成。该提醒不会对主动 cancel、bash 页面 exit 或连接断开导致的取消发送。",
      details: [
        { label: "最后状态", value: previous.state },
        { label: "运行时间", value: previous.elapsed }
      ],
      notice: "日志折叠区展示任务输出最后 24 行，便于快速判断是否正常结束。",
      includeLog: true
    });
  }

  for (const job of jobs) {
    const settings = settingsByUser.get(job.user);
    if (!settings) {
      nextDetailedJobs.set(job.id, detailedSlurmJobs.get(job.id) ?? job);
      continue;
    }
    if (!settings?.reminderEmail) continue;
    let detailJob: SlurmJob | null = detailedSlurmJobs.get(job.id) ?? null;
    const detailFor = async () => {
      if (!detailJob) detailJob = await getDetailedJob(job);
      nextDetailedJobs.set(job.id, detailJob);
      return detailJob;
    };
    if (settings.notifyJobFinished && shouldSendJobNotification(settings, job)) {
      await detailFor();
    }

    const previous = previousSlurmJobs.get(job.id);
    if (settings.notifyReservationStarted && previous && /PENDING/i.test(previous.state) && /RUNNING/i.test(job.state)) {
      const detail = await detailFor();
      if (shouldSendJobNotification(settings, detail)) {
        await sendJobNotification({
          eventKey: `reservation-started:${job.id}`,
          eventType: "reservation-started",
          job: detail,
          title: "预约 Job 已开始运行",
          summaryLabel: "运行任务",
          summaryValue: job.name || `Job ${job.id}`,
          body: "你预约或排队的任务现在已经进入 RUNNING 状态。",
          details: [{ label: "开始检测时间", value: new Date().toISOString(), monospace: true }],
          notice: "该提醒基于 Slurm 队列状态从 PENDING 切换到 RUNNING。"
        });
      }
    }

    if (settings.notifyJobOverdue && job.estimatedOverdue) {
      const detail = await detailFor();
      if (shouldSendJobNotification(settings, detail)) {
        await sendJobNotification({
          eventKey: `job-overdue:${job.id}`,
          eventType: "job-overdue",
          job: detail,
          title: "Job 已超过预计时间",
          summaryLabel: "超时任务",
          summaryValue: job.name || `Job ${job.id}`,
          body: "该任务已经达到或超过你提交时填写的预计用时，但仍处于运行或等待状态。TensorMesh 不会自动 kill 任务。",
          details: [
            { label: "预计结束", value: job.estimatedEndAt ?? "-", monospace: true },
            { label: "当前状态", value: job.state }
          ],
          notice: "预计时间只用于协作提醒，不是 Slurm 硬时间限制。"
        });
      }
    }

    if (settings.notifyLowGpu && /RUNNING/i.test(job.state)) {
      const detail = await detailFor();
      if (shouldSendJobNotification(settings, detail)) {
        const gpuIndexes = parseGpuIndexesFromGres(detail.gres ?? job.gres);
        const utilization = getAverageGpuUtilization(gpuIndexes, settings.lowGpuMinutes);
        if (utilization && utilization.averageUtilization < settings.lowGpuThreshold) {
          await sendJobNotification({
            eventKey: `low-gpu:${job.id}:${settings.lowGpuMinutes}:${settings.lowGpuThreshold}`,
            eventType: "low-gpu",
            job: detail,
            title: "GPU 利用率偏低",
            summaryLabel: `${settings.lowGpuMinutes} 分钟平均利用率`,
            summaryValue: `${utilization.averageUtilization}%`,
            body: `该任务最近 ${settings.lowGpuMinutes} 分钟的平均 GPU 利用率低于 ${settings.lowGpuThreshold}%。`,
            details: [
              { label: "阈值", value: `${settings.lowGpuThreshold}%` },
              { label: "采样数", value: String(utilization.sampleCount) }
            ],
            notice: "低利用率提醒只发送一次；如需重新提醒，可调整阈值或观察窗口后保存设置。"
          });
        }
      }
    }
  }

  for (const job of jobs) {
    if (!nextDetailedJobs.has(job.id)) {
      nextDetailedJobs.set(job.id, detailedSlurmJobs.get(job.id) ?? job);
    }
  }
  previousSlurmJobs = currentJobs;
  detailedSlurmJobs = nextDetailedJobs;
}

function mergeManualData(status: RuntimeStatus): RuntimeStatus {
  const manualTasks = getActiveTasks();
  const reservations = getActiveReservations();
  const slurmJobs = status.slurm?.jobs ?? [];
  const tasksByGpu = new Map<number, Task>();
  const reservationsByGpu = new Map<number, Reservation>();
  const slurmTasksByGpu = new Map<number, Task>();
  const manualGpuIndexes = new Set<number>();

  for (const task of manualTasks) {
    for (const gpuIndex of task.gpuIndexes) {
      tasksByGpu.set(gpuIndex, task);
      manualGpuIndexes.add(gpuIndex);
    }
  }

  for (const reservation of reservations) {
    for (const gpuIndex of reservation.gpuIndexes ?? []) {
      reservationsByGpu.set(gpuIndex, reservation);
    }
  }

  for (const job of slurmJobs) {
    if (!/RUNNING|PENDING|CONFIGURING|COMPLETING|SUSPENDED/i.test(job.state)) continue;
    const gpuIndexes = job.allocatedGpuIndexes ?? [];
    if (gpuIndexes.length === 0) continue;
    const startedAt = slurmTaskStartedAt.get(job.id) ?? new Date().toISOString();
    slurmTaskStartedAt.set(job.id, startedAt);
    const task: Task = {
      id: `slurm_${job.id}`,
      user: job.user,
      project: "Slurm",
      content: `#${job.id} ${job.name}${job.reason && job.reason !== "None" ? ` · ${job.reason}` : ""}`,
      command: job.command ?? job.name,
      gpuIndexes,
      status: /PENDING/i.test(job.state) ? "reserved" : "running",
      startedAt,
      expectedEndAt: job.estimatedEndAt,
      taskNote: `Slurm ${job.state}${job.reason ? ` · ${job.reason}` : ""}`
    };
    for (const gpuIndex of gpuIndexes) {
      slurmTasksByGpu.set(gpuIndex, task);
    }
  }

  return {
    ...status,
    tasks: [
      ...manualTasks,
      ...status.tasks.filter(
        (task) => !task.id.startsWith("task_") && !task.gpuIndexes.some((gpuIndex) => manualGpuIndexes.has(gpuIndex))
      )
    ],
    reservations,
    gpus: status.gpus.map((gpu) => {
      const manualTask = tasksByGpu.get(gpu.index);
      const reservation = reservationsByGpu.get(gpu.index);
      const slurmTask = slurmTasksByGpu.get(gpu.index);

      if (manualTask) {
        return {
          ...gpu,
          currentTask: manualTask,
          state: "running"
        };
      }

      if (slurmTask) {
        const existingProcesses = gpu.processes ?? [];
        const realProcesses = existingProcesses.filter((process) => process.pid > 0);
        const hasProcessForSlurmUser = existingProcesses.some((process) => process.username === slurmTask.user);
        const processes: GpuProcess[] = hasProcessForSlurmUser
          ? existingProcesses
          : [
              ...existingProcesses,
              {
                pid: 0,
                username: slurmTask.user,
                command: slurmTask.command,
                memoryUsedMb: 0,
                startedAt: slurmTask.startedAt
              }
            ];
        return {
          ...gpu,
          currentTask: slurmTask,
          processes,
          state: realProcesses.length > 0 || gpu.memoryUsedMb > 1024 || gpu.utilizationPercent > 5 ? "running" : "reserved"
        };
      }

      if (reservation && gpu.state === "idle") {
        return {
          ...gpu,
          reservation,
          state: "reserved"
        };
      }

      return {
        ...gpu,
        reservation: reservation ?? gpu.reservation
      };
    })
  };
}

function listStatusUsers(status: SystemStatus): string[] {
  const users = new Set<string>([...getKnownUsers(), ...listLocalLoginUsers()]);

  for (const task of status.tasks) users.add(task.user);
  for (const reservation of status.reservations) users.add(reservation.user);
  for (const gpu of status.gpus) {
    if (gpu.currentTask?.user) users.add(gpu.currentTask.user);
    if (gpu.reservation?.user) users.add(gpu.reservation.user);
  }

  return Array.from(users)
    .map((user) => user.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function listLocalLoginUsers(): string[] {
  try {
    return readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .filter((parts) => parts.length >= 7)
      .filter((parts) => {
        const uid = Number(parts[2]);
        const shell = parts[6] ?? "";
        return Number.isInteger(uid)
          && uid >= 1000
          && uid < 60000
          && !/nologin|false$/i.test(shell)
          && parts[0] !== "nobody";
      })
      .map((parts) => parts[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function collectStatus(): Promise<RuntimeStatus> {
  if (process.env.TENSORMESH_MOCK === "1") {
    const mockStatus = getMockSystemStatus();
    const slurm = await hydrateSlurmStatus(await getSlurmStatus({ allJobs: true }));
    const status: RuntimeStatus = {
      ...mockStatus,
      cpu: await collectCpuStatus().catch(() => mockStatus.cpu),
      slurm,
      collector: { source: "mock", reason: "TENSORMESH_MOCK=1" }
    };
    latestStatus = mergeManualData(status);
    if (slurm.available) await recordObservedSlurmJobHistory(slurm.jobs, latestStatus.updatedAt);
    recordStatusSamples(latestStatus);
    void evaluateNotifications(latestStatus);
    void flushQueuedLocalNotices();
    return latestStatus;
  }

  try {
    const slurm = await hydrateSlurmStatus(await getSlurmStatus({ allJobs: true }));
    const status: RuntimeStatus = {
      ...(await collectNvidiaStatus()),
      slurm,
      collector: { source: "nvidia-smi" }
    };
    latestStatus = mergeManualData(status);
    if (slurm.available) await recordObservedSlurmJobHistory(slurm.jobs, latestStatus.updatedAt);
    recordStatusSamples(latestStatus);
    void evaluateNotifications(latestStatus);
    void flushQueuedLocalNotices();
    return latestStatus;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const slurm = await hydrateSlurmStatus(await getSlurmStatus({ allJobs: true }));
    const status: RuntimeStatus = {
      serverName: process.env.TENSORMESH_SERVER_NAME ?? os.hostname(),
      updatedAt: new Date().toISOString(),
      cpu: await collectCpuStatus().catch(() => undefined),
      slurm,
      gpus: [],
      tasks: [],
      reservations: [],
      collector: {
        source: "unavailable",
        reason
      }
    };
    latestStatus = mergeManualData(status);
    if (slurm.available) await recordObservedSlurmJobHistory(slurm.jobs, latestStatus.updatedAt);
    recordStatusSamples(latestStatus);
    void evaluateNotifications(latestStatus);
    void flushQueuedLocalNotices();
    return latestStatus;
  }
}

async function refreshStatus(): Promise<RuntimeStatus> {
  if (latestCollectPromise) return latestCollectPromise;

  latestCollectPromise = collectStatus().finally(() => {
    latestCollectPromise = null;
  });

  return latestCollectPromise;
}

async function getStatus(): Promise<RuntimeStatus> {
  if (latestStatus) return latestStatus;
  return refreshStatus();
}

async function route(method: string, url: URL, request: IncomingMessage): Promise<ResponseInit> {
  if (method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  const session = await getRequestSession(url, request);

  if (method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "tensormesh-server",
      host,
      webUrlBase,
      collectIntervalMs,
      database: getDatabaseInfo()
    });
  }

  if (method === "GET" && url.pathname === "/tokens") {
    return tokenRedirect(url);
  }

  if (url.pathname.startsWith("/api/")) {
    requireSession(session);
  }

  const status = await getStatus();

  if (method === "GET" && url.pathname === "/api/session") {
    const current = requireSession(session);
    return jsonResponse({
      user: current.user,
      expiresAt: current.expiresAt || undefined,
      settings: getUserSettings(current.user),
      mail: getMailConfigInfo()
    });
  }

  if (method === "POST" && url.pathname === "/api/tasks/register") {
    const current = requireSession(session);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const gpuIndexes = parseGpuIndexes(body.gpuIndexes);
    if (gpuIndexes.length === 0) {
      throw new Error("gpuIndexes is required");
    }
    const task = createTask({
      user: current.user,
      project: requireString(body.project, "project"),
      content: requireString(body.content, "content"),
      command: requireString(body.command, "command"),
      gpuIndexes,
      expectedEndAt: typeof body.expectedEndAt === "string" && body.expectedEndAt ? body.expectedEndAt : undefined,
      timeNote: typeof body.timeNote === "string" ? body.timeNote : undefined,
      taskNote: typeof body.taskNote === "string" ? body.taskNote : undefined
    });
    latestStatus = latestStatus ? mergeManualData(latestStatus) : latestStatus;
    return jsonResponse(task, 201);
  }

  if (method === "POST" && url.pathname === "/api/reservations") {
    const current = requireSession(session);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const gpuIndexes = parseGpuIndexes(body.gpuIndexes);
    if (gpuIndexes.length === 0) {
      throw new Error("gpuIndexes is required");
    }
    const reservation = createReservation({
      user: current.user,
      gpuIndexes,
      gpuCount: typeof body.gpuCount === "number" ? body.gpuCount : undefined,
      project: requireString(body.project, "project"),
      content: requireString(body.content, "content"),
      command: requireString(body.command, "command"),
      workingDirectory: requireString(body.workingDirectory, "workingDirectory"),
      requestedStartAt: requireString(body.requestedStartAt, "requestedStartAt"),
      expiresAt: requireString(body.expiresAt, "expiresAt"),
      note: typeof body.note === "string" ? body.note : undefined
    });
    latestStatus = latestStatus ? mergeManualData(latestStatus) : latestStatus;
    return jsonResponse(reservation, 201);
  }

  const finishTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/finish$/);
  if (method === "POST" && finishTaskMatch) {
    const ok = finishTask(decodeURIComponent(finishTaskMatch[1]));
    latestStatus = latestStatus ? mergeManualData(latestStatus) : latestStatus;
    return jsonResponse({ ok });
  }

  const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/);
  if (method === "POST" && cancelJobMatch) {
    const current = requireSession(session);
    const jobId = cancelJobMatch[1];
    const job = await getSlurmJob(jobId);
    if (job.user !== current.user) throw new Error("only the job owner can cancel this Slurm job");
    await cancelSlurmJob(jobId);
    return jsonResponse({ ok: true, jobId });
  }

  if (method === "GET" && url.pathname === "/api/jobs/history") {
    const current = requireSession(session);
    const days = clampNumber(getQueryNumber(url, "days", 14), 1 / 24, 365);
    const limit = clampNumber(Math.round(getQueryNumber(url, "limit", 50)), 1, 500);
    const active = getQueryBoolean(url, "active");
    return jsonResponse(getSlurmJobHistoryFromDb({
      user: current.user,
      days,
      limit,
      active
    }));
  }

  const jobLogMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/log$/);
  if (method === "GET" && jobLogMatch) {
    const current = requireSession(session);
    const jobId = jobLogMatch[1];
    const job = await getSlurmJob(jobId);
    if (job.user !== current.user) throw new Error("only the job owner can read this Slurm job log");
    const maxBytes = Math.min(Math.max(getQueryNumber(url, "maxBytes", 64 * 1024), 1024), 512 * 1024);
    const logPath = getSafeLogPath(jobId, job);
    if (!logPath) return jsonResponse({ jobId, path: null, content: "" });
    return jsonResponse({ jobId, path: logPath, content: await readLogTail(logPath, maxBytes) });
  }

  if (method === "GET" && url.pathname === "/api/tmux/sessions") {
    const current = requireSession(session);
    return jsonResponse({
      user: current.user,
      sessions: await listUserTmeshSessions(current.user)
    });
  }

  const tmuxSessionMatch = url.pathname.match(/^\/api\/tmux\/sessions\/([^/]+)$/);
  if (method === "GET" && tmuxSessionMatch) {
    const current = requireSession(session);
    const access = getTmeshTmuxAccessForUser(current.user);
    const sessions = await listTmeshTmuxSessions(access);
    const target = findTmeshSessionForRequest(sessions, tmuxSessionMatch[1]);
    if (!target) throw new Error("TensorMesh session not found");
    await assertTmeshSessionOwner(target, current.user);
    const lineCount = clampNumber(Math.round(getQueryNumber(url, "lines", 200)), 1, 2000);
    const startLine = Math.round(getQueryNumber(url, "startLine", -lineCount));
    const logBytes = clampNumber(Math.round(getQueryNumber(url, "logBytes", 64 * 1024)), 0, 512 * 1024);
    return jsonResponse(await getTmeshTmuxSessionSnapshot(target.id, {
      startLine,
      lineCount,
      logBytes,
      access
    }));
  }

  const tmuxInputMatch = url.pathname.match(/^\/api\/tmux\/sessions\/([^/]+)\/input$/);
  if (method === "POST" && tmuxInputMatch) {
    const current = requireSignedSession(session);
    const access = getTmeshTmuxAccessForUser(current.user);
    const sessions = await listTmeshTmuxSessions(access);
    const target = findTmeshSessionForRequest(sessions, tmuxInputMatch[1]);
    if (!target) throw new Error("TensorMesh session not found");
    await assertTmeshSessionOwner(target, current.user);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const input = requireNonEmptyText(body.input, "input");
    if (input.length > 16 * 1024) throw new Error("input is too large; limit is 16 KiB");
    return jsonResponse(await sendTmeshTmuxSessionInput(target.id, input, {
      enter: optionalBodyBoolean(body.enter) ?? true,
      literal: optionalBodyBoolean(body.literal) ?? true,
      access
    }));
  }

  if (method === "PATCH" && url.pathname === "/api/session/settings") {
    const current = requireSession(session);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const reminderEmail = typeof body.reminderEmail === "string" ? body.reminderEmail : undefined;
    if (reminderEmail && !isValidEmail(reminderEmail)) {
      throw new Error("reminderEmail must be a valid email address");
    }
    return jsonResponse(updateUserSettings(current.user, {
      reminderEmail,
      notifyJobFinished: optionalBoolean(body.notifyJobFinished),
      notifyReservationStarted: optionalBoolean(body.notifyReservationStarted),
      notifyJobOverdue: optionalBoolean(body.notifyJobOverdue),
      notifyLowGpu: optionalBoolean(body.notifyLowGpu),
      noticeMode: optionalNoticeMode(body.noticeMode),
      lowGpuMinutes: optionalNumber(body.lowGpuMinutes),
      lowGpuThreshold: optionalNumber(body.lowGpuThreshold)
    }));
  }

  if (method === "POST" && url.pathname === "/api/local-notice") {
    const current = requireSignedSession(session);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const title = truncateText(requireString(body.title, "title"), 120);
    const content = truncateText(requireString(body.content, "content"), 12_000);
    const logTail = optionalString(body.logTail);
    const result = await handleLocalNotice({
      user: current.user,
      title,
      content,
      logTail: logTail ? truncateText(logTail, 64 * 1024) : undefined
    });
    return jsonResponse({
      ok: true,
      ...result,
      quota: {
        limit: getLocalNoticeQuotaLimit(),
        windowMinutes: 30
      }
    }, result.status === "sent" ? 200 : 202);
  }

  if (method === "POST" && url.pathname === "/api/session/test-mail") {
    const current = requireSession(session);
    const settings = getUserSettings(current.user);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const toMail = optionalString(body.toMail) ?? settings.reminderEmail;
    if (!toMail || !isValidEmail(toMail)) {
      throw new Error("Set a valid reminder email before sending a test mail");
    }
    const result = await sendCloudMail({
      toName: current.user,
      toMail,
      subject: "TensorMesh 邮件提醒测试",
      isHtml: true,
      content: renderTensorMeshMail({
        title: "邮件提醒已启用",
        recipientName: current.user,
        body: "这是一封由 TensorMesh 服务端发送的测试邮件。收到此邮件代表提醒邮箱和 Mail API 配置均可正常使用。",
        summaryLabel: "通知状态",
        summaryValue: "Ready",
        details: [
          { label: "TensorMesh 用户", value: current.user },
          { label: "目标邮箱", value: toMail },
          { label: "发送时间", value: new Date().toISOString(), monospace: true }
        ],
        notice: "后续任务完成、预约提醒和超时提示会复用这套邮件样式。"
      })
    });
    return jsonResponse({
      ok: true,
      status: result.status,
      body: result.body
    });
  }

  if (method === "GET" && url.pathname === "/api/status") {
    return jsonResponse(status);
  }

  if (method === "GET" && url.pathname === "/api/slurm") {
    return jsonResponse(status.slurm ?? (await getSlurmStatus({ allJobs: true })));
  }

  if (method === "GET" && url.pathname === "/api/nvidia-smi") {
    return jsonResponse(await runNvidiaSmi(url.searchParams.getAll("arg")));
  }

  if (method === "GET" && url.pathname === "/api/shared-tasks") {
    return jsonResponse({ tasks: listSharedTasks() });
  }

  if (method === "POST" && url.pathname === "/api/shared-tasks") {
    const current = requireSession(session);
    if (!isShareAdminUser(current.user)) {
      throw new HttpError(403, "only root may register shared tasks (use sudo tmesh share)");
    }
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const gpuIndexes = parseGpuIndexes(body.gpuIndexes);
    if (gpuIndexes.length === 0) {
      throw new Error("gpuIndexes is required");
    }
    const entry = registerSharedTask({
      id: requireString(body.id, "id"),
      user: current.user,
      gpuIndexes,
      scope: requireString(body.scope, "scope"),
      command: requireString(body.command, "command"),
      startedAt: typeof body.startedAt === "string" && body.startedAt ? body.startedAt : new Date().toISOString(),
      createdBy: current.user
    });
    latestStatus = latestStatus ? mergeManualData(latestStatus) : latestStatus;
    return jsonResponse(entry, 201);
  }

  const sharedTaskDeleteMatch = url.pathname.match(/^\/api\/shared-tasks\/([^/]+)$/);
  if (method === "DELETE" && sharedTaskDeleteMatch) {
    const current = requireSession(session);
    if (!isShareAdminUser(current.user)) {
      throw new HttpError(403, "only root may unregister shared tasks (use sudo tmesh share)");
    }
    const ok = unregisterSharedTask(decodeURIComponent(sharedTaskDeleteMatch[1]));
    latestStatus = latestStatus ? mergeManualData(latestStatus) : latestStatus;
    return jsonResponse({ ok });
  }

  if (method === "GET" && url.pathname === "/api/export/current.csv") {
    const rows = (status.slurm?.jobs ?? []).map((job) => ({
      timestamp: status.updatedAt,
      jobId: job.id,
      user: job.user,
      state: job.state,
      gpus: job.gres ?? "",
      elapsed: job.elapsed,
      timeLimit: job.timeLimit,
      killRemaining: job.killRemaining ?? "",
      killAt: job.killAt ?? "",
      estimate: job.estimatedEndAt ?? "",
      name: job.name,
      reason: job.reason,
      workDir: job.workDir ?? "",
      command: job.command ?? ""
    }));
    return csvResponse("tensormesh-current.csv", rows, [
      "timestamp",
      "jobId",
      "user",
      "state",
      "gpus",
      "elapsed",
      "timeLimit",
      "killRemaining",
      "killAt",
      "estimate",
      "name",
      "reason",
      "workDir",
      "command"
    ]);
  }

  if (method === "GET" && url.pathname === "/api/export/current.html") {
    const rows = (status.slurm?.jobs ?? []).map((job) => ({
      时间: status.updatedAt,
      Job: job.id,
      用户: job.user,
      状态: job.state,
      GPU: job.gres ?? "",
      运行时间: job.elapsed,
      硬限制: job.timeLimit,
      强制终止剩余: job.killRemaining ?? "",
      强制终止时间: job.killAt ?? "",
      预计结束: job.estimatedEndAt ?? "",
      名称: job.name,
      原因: job.reason,
      工作目录: job.workDir ?? "",
      命令: job.command ?? ""
    }));
    return htmlTableResponse("TensorMesh 当前 Slurm Job 表", rows, [
      "时间",
      "Job",
      "用户",
      "状态",
      "GPU",
      "运行时间",
      "硬限制",
      "强制终止剩余",
      "强制终止时间",
      "预计结束",
      "名称",
      "原因",
      "工作目录",
      "命令"
    ]);
  }

  if (method === "GET" && url.pathname === "/api/export/midnight.csv") {
    const rows = getMidnightRows(14);
    return csvResponse("tensormesh-midnight-14d.csv", rows, [
      "timestamp",
      "serverName",
      "gpuIndex",
      "gpuName",
      "memoryTotalMb",
      "memoryUsedMb",
      "utilizationPercent",
      "state",
      "user",
      "taskId",
      "command"
    ]);
  }

  if (method === "GET" && url.pathname === "/api/export/midnight.html") {
    return htmlTableResponse("TensorMesh 过去 14 天 0 点快照", getMidnightRows(14), [
      "timestamp",
      "serverName",
      "gpuIndex",
      "gpuName",
      "memoryTotalMb",
      "memoryUsedMb",
      "utilizationPercent",
      "state",
      "user",
      "taskId",
      "command"
    ]);
  }

  if (method === "GET" && url.pathname === "/api/gpus") {
    return jsonResponse(status.gpus);
  }

  if (method === "GET" && url.pathname === "/api/users") {
    return jsonResponse(listStatusUsers(status));
  }

  const gpuHistoryMatch = url.pathname.match(/^\/api\/gpus\/(\d+)\/history$/);
  if (method === "GET" && gpuHistoryMatch) {
    const gpuIndex = Number(gpuHistoryMatch[1]);
    const days = clampNumber(getQueryNumber(url, "days", 14), 1 / 24, 14);
    const limit = clampNumber(Math.round(getQueryNumber(url, "limit", 1200)), 24, 5000);
    const bucketSeconds = clampNumber(Math.round(getQueryNumber(url, "bucketSeconds", 10)), 10, 24 * 60 * 60);
    const from = getQueryDate(url, "from");
    const to = getQueryDate(url, "to");
    return jsonResponse({
      gpuIndex,
      days,
      from,
      to,
      limit,
      bucketSeconds,
      samples: getGpuHistoryFromDb({ gpuIndex, days, from, to, limit, bucketSeconds })
    });
  }

  const usageMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/usage$/);
  if (method === "GET" && usageMatch) {
    const user = decodeURIComponent(usageMatch[1]);
    const days = getQueryNumber(url, "days", 14);
    return jsonResponse(getUsageSummaryFromDb(user, days));
  }

  if (method === "GET" && url.pathname === "/api/tasks") {
    return jsonResponse(status.tasks);
  }

  if (method === "GET" && url.pathname === "/api/reservations") {
    return jsonResponse(status.reservations);
  }

  return jsonResponse(
    {
      error: "not_found",
      message: `No mock route for ${method} ${url.pathname}`
    },
    404
  );
}

const server = createServer((request, response) => {
  const host = request.headers.host ?? `localhost:${port}`;
  const url = new URL(request.url ?? "/", `http://${host}`);
  const method = request.method ?? "GET";
  const routeMethod = method === "HEAD" ? "GET" : method;
  route(routeMethod, url, request)
    .then((result) => {
      response.writeHead(result.status, result.headers);
      response.end(method === "HEAD" ? undefined : result.body);
    })
    .catch((error: unknown) => {
      const result = jsonResponse(
        {
          error: error instanceof HttpError ? "request_error" : "internal_error",
          message: error instanceof Error ? error.message : String(error)
        },
        error instanceof HttpError ? error.status : 500
      );
      response.writeHead(result.status, result.headers);
      response.end(method === "HEAD" ? undefined : result.body);
    });
});

refreshStatus().catch(() => undefined);
setInterval(() => {
  refreshStatus().catch(() => undefined);
}, collectIntervalMs).unref();
setInterval(() => {
  pruneHistory(14);
  pruneSlurmJobHistory(Number.isFinite(jobHistoryRetentionDays) && jobHistoryRetentionDays > 0 ? jobHistoryRetentionDays : 240);
}, 60 * 60 * 1000).unref();

server.listen(port, host, () => {
  process.stdout.write(`TensorMesh API server listening on http://${host}:${port}\n`);
});
