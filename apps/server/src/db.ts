import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isActiveSlurmJobState, type GpuSample, type Reservation, type SlurmJob, type SlurmJobHistory, type SlurmJobHistoryEntry, type SystemStatus, type Task, type UsageSummary } from "@tensormesh/shared";

const defaultDatabasePath = fileURLToPath(new URL("../../../data/tensormesh.db", import.meta.url));
const databasePath = process.env.TENSORMESH_DB_PATH ?? defaultDatabasePath;

mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
const runId = `${Date.now()}-${process.pid}`;

function tableSql(tableName: string): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql?: string } | undefined;
  return row?.sql;
}

const existingNotificationEventsSql = tableSql("notification_events");
if (existingNotificationEventsSql && !/event_key\s+TEXT\s+PRIMARY\s+KEY/i.test(existingNotificationEventsSql)) {
  db.exec(`
    DROP TABLE IF EXISTS notification_events;
    DROP INDEX IF EXISTS idx_notification_events_key_status;
  `);
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS collector_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    server_name TEXT
  );

  CREATE TABLE IF NOT EXISTS gpu_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    server_name TEXT NOT NULL,
    gpu_index INTEGER NOT NULL,
    gpu_uuid TEXT NOT NULL,
    gpu_name TEXT NOT NULL,
    memory_total_mb INTEGER NOT NULL,
    memory_used_mb INTEGER NOT NULL,
    utilization_percent INTEGER NOT NULL,
    temperature_c INTEGER NOT NULL,
    power_w REAL NOT NULL,
    state TEXT NOT NULL,
    user TEXT,
    task_id TEXT,
    command TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_gpu_samples_run_gpu_time
    ON gpu_samples(run_id, gpu_index, timestamp);

  CREATE INDEX IF NOT EXISTS idx_gpu_samples_gpu_time
    ON gpu_samples(gpu_index, timestamp);

  CREATE TABLE IF NOT EXISTS job_history (
    job_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user TEXT NOT NULL,
    state TEXT NOT NULL,
    partition_name TEXT,
    nodes TEXT,
    elapsed TEXT,
    time_limit TEXT,
    reason TEXT,
    slurm_reason TEXT,
    task_description TEXT,
    comment TEXT,
    notice INTEGER NOT NULL DEFAULT 0,
    estimated_hours REAL,
    estimated_end_at TEXT,
    estimated_overdue INTEGER NOT NULL DEFAULT 0,
    allocated_gpu_indexes TEXT,
    tres TEXT,
    gres TEXT,
    work_dir TEXT,
    command TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    active INTEGER NOT NULL,
    submitted_at TEXT,
    started_at TEXT,
    exit_code TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_job_history_user_last_seen
    ON job_history(user, last_seen_at DESC);

  CREATE INDEX IF NOT EXISTS idx_job_history_active_user
    ON job_history(active, user, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    project TEXT NOT NULL,
    content TEXT NOT NULL,
    command TEXT NOT NULL,
    gpu_indexes TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    expected_end_at TEXT,
    ended_at TEXT,
    time_note TEXT,
    task_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    gpu_indexes TEXT,
    gpu_count INTEGER,
    project TEXT NOT NULL,
    content TEXT NOT NULL,
    command TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    requested_start_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    auto_run_enabled INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status_started
    ON tasks(status, started_at);

  CREATE INDEX IF NOT EXISTS idx_reservations_status_start
    ON reservations(status, requested_start_at);

  CREATE TABLE IF NOT EXISTS user_settings (
    user TEXT PRIMARY KEY,
    reminder_email TEXT,
    notify_job_finished INTEGER NOT NULL DEFAULT 0,
    notify_reservation_started INTEGER NOT NULL DEFAULT 0,
    notify_job_overdue INTEGER NOT NULL DEFAULT 0,
    notify_low_gpu INTEGER NOT NULL DEFAULT 0,
    notice_mode TEXT NOT NULL DEFAULT 'explicit',
    low_gpu_minutes INTEGER NOT NULL DEFAULT 30,
    low_gpu_threshold INTEGER NOT NULL DEFAULT 50,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_events (
    event_key TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    job_id TEXT,
    event_type TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT
  );

  CREATE TABLE IF NOT EXISTS local_notice_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    log_tail TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS local_notice_quota (
    user TEXT PRIMARY KEY,
    window_started_at TEXT NOT NULL,
    used_count INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notification_events_key_status
    ON notification_events(event_key, status);
`);

db.exec(`
  UPDATE job_history
  SET state = 'ENDED'
  WHERE active = 0
    AND state IN ('PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'SUSPENDED', 'RESIZING', 'REQUEUED');
`);

function addColumnIfMissing(statement: string): void {
  try {
    db.exec(statement);
  } catch {
    // Older installations may already have the column.
  }
}

addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN notify_job_finished INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN notify_reservation_started INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN notify_job_overdue INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN notify_low_gpu INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN notice_mode TEXT NOT NULL DEFAULT 'explicit'");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN low_gpu_minutes INTEGER NOT NULL DEFAULT 30");
addColumnIfMissing("ALTER TABLE user_settings ADD COLUMN low_gpu_threshold INTEGER NOT NULL DEFAULT 50");

const insertRun = db.prepare(`
  INSERT OR IGNORE INTO collector_runs (id, started_at, server_name)
  VALUES (?, ?, ?)
`);

const insertSample = db.prepare(`
  INSERT INTO gpu_samples (
    run_id,
    timestamp,
    server_name,
    gpu_index,
    gpu_uuid,
    gpu_name,
    memory_total_mb,
    memory_used_mb,
    utilization_percent,
    temperature_c,
    power_w,
    state,
    user,
    task_id,
    command
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectHistory = db.prepare(`
  SELECT *
  FROM (
    SELECT
      MIN(timestamp) AS timestamp,
      gpu_index AS gpuIndex,
      CAST(AVG(memory_used_mb) AS INTEGER) AS memoryUsedMb,
      CAST(AVG(utilization_percent) AS INTEGER) AS utilizationPercent,
      MAX(user) AS user,
      MAX(task_id) AS taskId
    FROM gpu_samples
    WHERE gpu_index = ?
      AND timestamp >= ?
      AND timestamp <= ?
    GROUP BY CAST(strftime('%s', timestamp) / ? AS INTEGER)
    ORDER BY MIN(timestamp) DESC
    LIMIT ?
  )
  ORDER BY timestamp ASC
`);

const pruneOldSamples = db.prepare(`
  DELETE FROM gpu_samples
  WHERE timestamp < ?
`);

const upsertJobHistory = db.prepare(`
  INSERT INTO job_history (
    job_id,
    name,
    user,
    state,
    partition_name,
    nodes,
    elapsed,
    time_limit,
    reason,
    slurm_reason,
    task_description,
    comment,
    notice,
    estimated_hours,
    estimated_end_at,
    estimated_overdue,
    allocated_gpu_indexes,
    tres,
    gres,
    work_dir,
    command,
    first_seen_at,
    last_seen_at,
    ended_at,
    active,
    submitted_at,
    started_at,
    exit_code
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(job_id) DO UPDATE SET
    name = excluded.name,
    user = excluded.user,
    state = excluded.state,
    partition_name = excluded.partition_name,
    nodes = excluded.nodes,
    elapsed = excluded.elapsed,
    time_limit = excluded.time_limit,
    reason = excluded.reason,
    slurm_reason = excluded.slurm_reason,
    task_description = excluded.task_description,
    comment = excluded.comment,
    notice = excluded.notice,
    estimated_hours = excluded.estimated_hours,
    estimated_end_at = excluded.estimated_end_at,
    estimated_overdue = excluded.estimated_overdue,
    allocated_gpu_indexes = excluded.allocated_gpu_indexes,
    tres = excluded.tres,
    gres = excluded.gres,
    work_dir = excluded.work_dir,
    command = excluded.command,
    last_seen_at = excluded.last_seen_at,
    ended_at = CASE
      WHEN excluded.active = 1 THEN NULL
      WHEN job_history.ended_at IS NOT NULL THEN job_history.ended_at
      ELSE excluded.ended_at
    END,
    active = excluded.active,
    submitted_at = COALESCE(excluded.submitted_at, job_history.submitted_at),
    started_at = COALESCE(excluded.started_at, job_history.started_at),
    exit_code = COALESCE(excluded.exit_code, job_history.exit_code)
`);

const selectJobHistoryByUser = db.prepare(`
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
  WHERE user = ?
    AND last_seen_at >= ?
    AND (? IS NULL OR active = ?)
  ORDER BY last_seen_at DESC
  LIMIT ?
`);

const selectActiveHistoryJobIds = db.prepare(`
  SELECT job_id AS id
  FROM job_history
  WHERE active = 1
`);

const markJobHistoryInactive = db.prepare(`
  UPDATE job_history
  SET active = 0,
      state = CASE
        WHEN state IN ('PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'SUSPENDED', 'RESIZING', 'REQUEUED') THEN 'ENDED'
        ELSE state
      END,
      ended_at = COALESCE(ended_at, ?),
      last_seen_at = ?
  WHERE job_id = ?
    AND active = 1
`);

const pruneOldJobHistory = db.prepare(`
  DELETE FROM job_history
  WHERE active = 0
    AND last_seen_at < ?
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (
    id,
    user,
    project,
    content,
    command,
    gpu_indexes,
    status,
    started_at,
    expected_end_at,
    ended_at,
    time_note,
    task_note,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectActiveTasks = db.prepare(`
  SELECT *
  FROM tasks
  WHERE status IN ('running', 'reserved', 'stale')
  ORDER BY started_at DESC
`);

const updateTaskFinished = db.prepare(`
  UPDATE tasks
  SET status = 'finished',
      ended_at = ?,
      updated_at = ?
  WHERE id = ?
`);

const insertReservation = db.prepare(`
  INSERT INTO reservations (
    id,
    user,
    gpu_indexes,
    gpu_count,
    project,
    content,
    command,
    working_directory,
    requested_start_at,
    expires_at,
    status,
    auto_run_enabled,
    note,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectActiveReservations = db.prepare(`
  SELECT *
  FROM reservations
  WHERE status IN ('queued', 'armed', 'running')
  ORDER BY requested_start_at ASC
`);

const selectSamplesForUser = db.prepare(`
  SELECT
    timestamp,
    gpu_index AS gpuIndex,
    user,
    task_id AS taskId
  FROM gpu_samples
  WHERE user = ?
    AND timestamp >= ?
  ORDER BY gpu_index ASC, timestamp ASC
`);

const selectSamplesAtMidnight = db.prepare(`
  SELECT
    timestamp,
    server_name AS serverName,
    gpu_index AS gpuIndex,
    gpu_name AS gpuName,
    memory_total_mb AS memoryTotalMb,
    memory_used_mb AS memoryUsedMb,
    utilization_percent AS utilizationPercent,
    state,
    user,
    task_id AS taskId,
    command
  FROM gpu_samples
  WHERE timestamp >= ?
    AND substr(timestamp, 12, 5) = '00:00'
  ORDER BY timestamp ASC, gpu_index ASC
`);

const selectTasksForProject = db.prepare(`
  SELECT id, project
  FROM tasks
`);

const selectKnownUsers = db.prepare(`
  SELECT user
  FROM (
    SELECT DISTINCT user FROM gpu_samples WHERE user IS NOT NULL AND user != ''
    UNION
    SELECT DISTINCT user FROM tasks WHERE user IS NOT NULL AND user != ''
    UNION
    SELECT DISTINCT user FROM reservations WHERE user IS NOT NULL AND user != ''
  )
  ORDER BY user ASC
`);

const selectUserSettings = db.prepare(`
  SELECT
    user,
    reminder_email AS reminderEmail,
    notify_job_finished AS notifyJobFinished,
    notify_reservation_started AS notifyReservationStarted,
    notify_job_overdue AS notifyJobOverdue,
    notify_low_gpu AS notifyLowGpu,
    notice_mode AS noticeMode,
    low_gpu_minutes AS lowGpuMinutes,
    low_gpu_threshold AS lowGpuThreshold,
    updated_at AS updatedAt
  FROM user_settings
  WHERE user = ?
`);

const upsertUserSettings = db.prepare(`
  INSERT INTO user_settings (
    user,
    reminder_email,
    notify_job_finished,
    notify_reservation_started,
    notify_job_overdue,
    notify_low_gpu,
    notice_mode,
    low_gpu_minutes,
    low_gpu_threshold,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user) DO UPDATE SET
    reminder_email = excluded.reminder_email,
    notify_job_finished = excluded.notify_job_finished,
    notify_reservation_started = excluded.notify_reservation_started,
    notify_job_overdue = excluded.notify_job_overdue,
    notify_low_gpu = excluded.notify_low_gpu,
    notice_mode = excluded.notice_mode,
    low_gpu_minutes = excluded.low_gpu_minutes,
    low_gpu_threshold = excluded.low_gpu_threshold,
    updated_at = excluded.updated_at
`);

const selectAllUserSettings = db.prepare(`
  SELECT
    user,
    reminder_email AS reminderEmail,
    notify_job_finished AS notifyJobFinished,
    notify_reservation_started AS notifyReservationStarted,
    notify_job_overdue AS notifyJobOverdue,
    notify_low_gpu AS notifyLowGpu,
    notice_mode AS noticeMode,
    low_gpu_minutes AS lowGpuMinutes,
    low_gpu_threshold AS lowGpuThreshold,
    updated_at AS updatedAt
  FROM user_settings
`);

const selectNotificationEvent = db.prepare(`
  SELECT event_key AS eventKey
  FROM notification_events
  WHERE event_key = ?
    AND status = 'sent'
`);

const insertNotificationEvent = db.prepare(`
  INSERT OR REPLACE INTO notification_events (event_key, user, job_id, event_type, sent_at, status, message)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectLocalNoticeQuota = db.prepare(`
  SELECT user, window_started_at AS windowStartedAt, used_count AS usedCount
  FROM local_notice_quota
  WHERE user = ?
`);

const upsertLocalNoticeQuota = db.prepare(`
  INSERT INTO local_notice_quota (user, window_started_at, used_count)
  VALUES (?, ?, ?)
  ON CONFLICT(user) DO UPDATE SET
    window_started_at = excluded.window_started_at,
    used_count = excluded.used_count
`);

const insertLocalNotice = db.prepare(`
  INSERT INTO local_notice_queue (user, title, content, log_tail, status, created_at, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectQueuedLocalNotices = db.prepare(`
  SELECT id, user, title, content, log_tail AS logTail, created_at AS createdAt
  FROM local_notice_queue
  WHERE user = ?
    AND status = 'queued'
  ORDER BY created_at ASC
  LIMIT ?
`);

const countQueuedLocalNotices = db.prepare(`
  SELECT COUNT(*) AS count
  FROM local_notice_queue
  WHERE user = ?
    AND status = 'queued'
`);

const markLocalNoticeSent = db.prepare(`
  UPDATE local_notice_queue
  SET status = 'sent',
      sent_at = ?
  WHERE id = ?
`);


insertRun.run(runId, new Date().toISOString(), process.env.TENSORMESH_SERVER_NAME ?? null);

export function recordStatusSamples(status: SystemStatus): void {
  db.exec("BEGIN");

  try {
    for (const gpu of status.gpus) {
      insertSample.run(
        runId,
        status.updatedAt,
        status.serverName,
        gpu.index,
        gpu.uuid,
        gpu.name,
        gpu.memoryTotalMb,
        gpu.memoryUsedMb,
        gpu.utilizationPercent,
        gpu.temperatureC,
        gpu.powerW,
        gpu.state,
        gpu.currentTask?.user ?? null,
        gpu.currentTask?.id ?? null,
        gpu.currentTask?.command ?? null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordSlurmJobHistory(jobs: SlurmJob[], observedAt = new Date().toISOString()): void {
  db.exec("BEGIN");

  try {
    const currentJobIds = new Set(jobs.map((job) => job.id));
    for (const job of jobs) {
      const active = isActiveSlurmJobState(job.state);
      upsertJobHistory.run(
        job.id,
        job.name || "-",
        job.user || "-",
        job.state || "-",
        job.partition || null,
        job.nodes || null,
        job.elapsed || null,
        job.timeLimit || null,
        job.reason || null,
        job.slurmReason ?? null,
        job.taskDescription ?? null,
        job.comment ?? null,
        job.notice ? 1 : 0,
        job.estimatedHours ?? null,
        job.estimatedEndAt ?? null,
        job.estimatedOverdue ? 1 : 0,
        job.allocatedGpuIndexes ? JSON.stringify(job.allocatedGpuIndexes) : null,
        job.tres ?? null,
        job.gres ?? null,
        job.workDir ?? null,
        job.command ?? null,
        observedAt,
        observedAt,
        active ? null : job.endedAt ?? observedAt,
        active ? 1 : 0,
        job.submittedAt ?? null,
        job.startedAt ?? null,
        job.exitCode ?? null
      );
    }
    const activeRows = selectActiveHistoryJobIds.all() as unknown as Array<{ id: string }>;
    for (const row of activeRows) {
      if (!currentJobIds.has(String(row.id))) {
        markJobHistoryInactive.run(observedAt, observedAt, String(row.id));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getActiveSlurmJobHistoryIds(): string[] {
  const rows = selectActiveHistoryJobIds.all() as unknown as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}

function historyJobFromRow(row: Record<string, unknown>): SlurmJobHistoryEntry {
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
    allocatedGpuIndexes: parseGpuIndexes(row.allocatedGpuIndexes ? String(row.allocatedGpuIndexes) : undefined),
    tres: row.tres ? String(row.tres) : undefined,
    gres: row.gres ? String(row.gres) : undefined,
    workDir: row.workDir ? String(row.workDir) : undefined,
    command: row.command ? String(row.command) : undefined,
    firstSeenAt: String(row.firstSeenAt),
    lastSeenAt: String(row.lastSeenAt),
    endedAt: row.endedAt ? String(row.endedAt) : undefined,
    active: Boolean(row.active),
    submittedAt: row.submittedAt ? String(row.submittedAt) : undefined,
    startedAt: row.startedAt ? String(row.startedAt) : undefined,
    exitCode: row.exitCode ? String(row.exitCode) : undefined
  };
}

export function getSlurmJobHistoryFromDb({
  user,
  days = 14,
  limit = 50,
  active
}: {
  user: string;
  days?: number;
  limit?: number;
  active?: boolean;
}): SlurmJobHistory {
  const safeDays = Math.max(1 / 24, days);
  const safeLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const activeValue = active === undefined ? null : active ? 1 : 0;
  const rows = selectJobHistoryByUser.all(user, cutoff, activeValue, activeValue, safeLimit) as unknown as Record<string, unknown>[];
  return {
    user,
    days: safeDays,
    limit: safeLimit,
    active,
    source: "sqlite",
    jobs: rows.map(historyJobFromRow)
  };
}

export function getGpuHistoryFromDb({
  gpuIndex,
  from,
  to = new Date().toISOString(),
  days = 14,
  limit = 1200,
  bucketSeconds = 10
}: {
  gpuIndex: number;
  from?: string;
  to?: string;
  days?: number;
  limit?: number;
  bucketSeconds?: number;
}): GpuSample[] {
  const fallbackFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return selectHistory.all(gpuIndex, from ?? fallbackFrom, to, bucketSeconds, limit) as unknown as GpuSample[];
}

export function pruneHistory(days = 14): void {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  pruneOldSamples.run(cutoff);
}

export function pruneSlurmJobHistory(days = 240): void {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  pruneOldJobHistory.run(cutoff);
}

export function getDatabaseInfo() {
  return {
    path: databasePath,
    runId
  };
}

function parseGpuIndexes(value: string | null | undefined): number[] | undefined {
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : undefined;
  } catch {
    return undefined;
  }
}

function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    user: String(row.user),
    project: String(row.project),
    content: String(row.content),
    command: String(row.command),
    gpuIndexes: parseGpuIndexes(String(row.gpu_indexes)) ?? [],
    status: row.status as Task["status"],
    startedAt: String(row.started_at),
    expectedEndAt: row.expected_end_at ? String(row.expected_end_at) : undefined,
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    timeNote: row.time_note ? String(row.time_note) : undefined,
    taskNote: row.task_note ? String(row.task_note) : undefined
  };
}

function reservationFromRow(row: Record<string, unknown>): Reservation {
  return {
    id: String(row.id),
    user: String(row.user),
    gpuIndexes: parseGpuIndexes(row.gpu_indexes ? String(row.gpu_indexes) : undefined),
    gpuCount: row.gpu_count == null ? undefined : Number(row.gpu_count),
    project: String(row.project),
    content: String(row.content),
    command: String(row.command),
    workingDirectory: String(row.working_directory),
    requestedStartAt: String(row.requested_start_at),
    expiresAt: String(row.expires_at),
    status: row.status as Reservation["status"],
    autoRunEnabled: Boolean(row.auto_run_enabled),
    note: row.note ? String(row.note) : undefined
  };
}

export type CreateTaskInput = Omit<Task, "id" | "status" | "startedAt"> & {
  startedAt?: string;
  status?: Task["status"];
};

export function createTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: input.status ?? "running",
    startedAt: input.startedAt ?? now,
    ...input
  };

  insertTask.run(
    task.id,
    task.user,
    task.project,
    task.content,
    task.command,
    JSON.stringify(task.gpuIndexes),
    task.status,
    task.startedAt,
    task.expectedEndAt ?? null,
    task.endedAt ?? null,
    task.timeNote ?? null,
    task.taskNote ?? null,
    now,
    now
  );

  return task;
}

export function getActiveTasks(): Task[] {
  return (selectActiveTasks.all() as unknown as Record<string, unknown>[]).map(taskFromRow);
}

export function finishTask(taskId: string): boolean {
  const now = new Date().toISOString();
  const result = updateTaskFinished.run(now, now, taskId);
  return result.changes > 0;
}

export type CreateReservationInput = Omit<Reservation, "id" | "status" | "autoRunEnabled"> & {
  status?: Reservation["status"];
  autoRunEnabled?: boolean;
};

export function createReservation(input: CreateReservationInput): Reservation {
  const now = new Date().toISOString();
  const reservation: Reservation = {
    id: `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: input.status ?? "queued",
    autoRunEnabled: input.autoRunEnabled ?? false,
    ...input
  };

  insertReservation.run(
    reservation.id,
    reservation.user,
    reservation.gpuIndexes ? JSON.stringify(reservation.gpuIndexes) : null,
    reservation.gpuCount ?? null,
    reservation.project,
    reservation.content,
    reservation.command,
    reservation.workingDirectory,
    reservation.requestedStartAt,
    reservation.expiresAt,
    reservation.status,
    reservation.autoRunEnabled ? 1 : 0,
    reservation.note ?? null,
    now,
    now
  );

  return reservation;
}

export function getActiveReservations(): Reservation[] {
  return (selectActiveReservations.all() as unknown as Record<string, unknown>[]).map(reservationFromRow);
}

function getTaskProjectMap(): Map<string, string> {
  const rows = selectTasksForProject.all() as unknown as Array<{ id: string; project: string }>;
  return new Map(rows.map((row) => [String(row.id), String(row.project)]));
}

export function getUsageSummaryFromDb(user: string, days: number): UsageSummary {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = selectSamplesForUser.all(user, cutoff) as unknown as Array<{
    timestamp: string;
    gpuIndex: number;
    user: string;
    taskId?: string | null;
  }>;
  const projectByTask = getTaskProjectMap();
  const byProject = new Map<string, number>();
  const daily = new Map<string, number>();
  let totalHours = 0;

  for (let index = 0; index < rows.length - 1; index += 1) {
    const current = rows[index];
    const next = rows[index + 1];

    if (current.gpuIndex !== next.gpuIndex) continue;
    const currentTime = new Date(current.timestamp).getTime();
    const nextTime = new Date(next.timestamp).getTime();
    const deltaMs = nextTime - currentTime;

    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 30_000) continue;

    const hours = deltaMs / 3_600_000;
    const project = current.taskId ? (projectByTask.get(current.taskId) ?? "未登记") : "未登记";
    const date = current.timestamp.slice(0, 10);

    totalHours += hours;
    byProject.set(project, (byProject.get(project) ?? 0) + hours);
    daily.set(date, (daily.get(date) ?? 0) + hours);
  }

  return {
    user,
    days,
    totalCardHours: Math.round(totalHours * 100) / 100,
    byProject: Array.from(byProject.entries()).map(([project, cardHours]) => ({
      project,
      cardHours: Math.round(cardHours * 100) / 100
    })),
    daily: Array.from(daily.entries()).map(([date, cardHours]) => ({
      date,
      cardHours: Math.round(cardHours * 100) / 100
    }))
  };
}

export function getMidnightRows(days = 14): Array<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return selectSamplesAtMidnight.all(cutoff) as unknown as Array<Record<string, unknown>>;
}

export function getKnownUsers(): string[] {
  const rows = selectKnownUsers.all() as unknown as Array<{ user: string }>;
  return rows.map((row) => row.user);
}

export interface UserSettings {
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

function normalizeUserSettings(row: {
  user: string;
  reminderEmail?: string | null;
  notifyJobFinished?: number | null;
  notifyReservationStarted?: number | null;
  notifyJobOverdue?: number | null;
  notifyLowGpu?: number | null;
  noticeMode?: string | null;
  lowGpuMinutes?: number | null;
  lowGpuThreshold?: number | null;
  updatedAt?: string;
} | undefined, user?: string): UserSettings {
  return {
    user: row?.user ?? user ?? "",
    reminderEmail: row?.reminderEmail ?? undefined,
    notifyJobFinished: Boolean(row?.notifyJobFinished),
    notifyReservationStarted: Boolean(row?.notifyReservationStarted),
    notifyJobOverdue: Boolean(row?.notifyJobOverdue),
    notifyLowGpu: Boolean(row?.notifyLowGpu),
    noticeMode: row?.noticeMode === "global" ? "global" : "explicit",
    lowGpuMinutes: Number.isFinite(Number(row?.lowGpuMinutes)) ? Number(row?.lowGpuMinutes) : 30,
    lowGpuThreshold: Number.isFinite(Number(row?.lowGpuThreshold)) ? Number(row?.lowGpuThreshold) : 50,
    updatedAt: row?.updatedAt
  };
}

export function getUserSettings(user: string): UserSettings {
  const row = selectUserSettings.get(user) as Parameters<typeof normalizeUserSettings>[0];
  return normalizeUserSettings(row, user);
}

export function getAllUserSettings(): UserSettings[] {
  return (selectAllUserSettings.all() as unknown as Array<Parameters<typeof normalizeUserSettings>[0]>).map((row) => normalizeUserSettings(row));
}

export function updateUserSettings(user: string, input: {
  reminderEmail?: string | null;
  notifyJobFinished?: boolean;
  notifyReservationStarted?: boolean;
  notifyJobOverdue?: boolean;
  notifyLowGpu?: boolean;
  noticeMode?: "explicit" | "global";
  lowGpuMinutes?: number;
  lowGpuThreshold?: number;
}): UserSettings {
  const now = new Date().toISOString();
  const current = getUserSettings(user);
  const reminderEmail = input.reminderEmail === undefined ? (current.reminderEmail ?? null) : input.reminderEmail?.trim() || null;
  const noticeMode = input.noticeMode ?? current.noticeMode;
  const lowGpuMinutes = Math.max(1, Math.min(24 * 60, Math.round(input.lowGpuMinutes ?? current.lowGpuMinutes)));
  const lowGpuThreshold = Math.max(1, Math.min(100, Math.round(input.lowGpuThreshold ?? current.lowGpuThreshold)));
  upsertUserSettings.run(
    user,
    reminderEmail,
    (input.notifyJobFinished ?? current.notifyJobFinished) ? 1 : 0,
    (input.notifyReservationStarted ?? current.notifyReservationStarted) ? 1 : 0,
    (input.notifyJobOverdue ?? current.notifyJobOverdue) ? 1 : 0,
    (input.notifyLowGpu ?? current.notifyLowGpu) ? 1 : 0,
    noticeMode,
    lowGpuMinutes,
    lowGpuThreshold,
    now
  );
  return getUserSettings(user);
}

export function hasNotificationEvent(eventKey: string): boolean {
  return Boolean(selectNotificationEvent.get(eventKey));
}

export function recordNotificationEvent(input: {
  eventKey: string;
  user: string;
  jobId?: string;
  eventType: string;
  status: string;
  message?: string;
}): void {
  insertNotificationEvent.run(
    input.eventKey,
    input.user,
    input.jobId ?? null,
    input.eventType,
    new Date().toISOString(),
    input.status,
    input.message ?? null
  );
}

export function getAverageGpuUtilization(gpuIndexes: number[], minutes: number): { averageUtilization: number; sampleCount: number } | null {
  if (gpuIndexes.length === 0) return null;
  const cutoff = new Date(Date.now() - Math.max(1, minutes) * 60 * 1000).toISOString();
  const placeholders = gpuIndexes.map(() => "?").join(",");
  const statement = db.prepare(`
    SELECT
      AVG(utilization_percent) AS averageUtilization,
      COUNT(*) AS sampleCount
    FROM gpu_samples
    WHERE run_id = ?
      AND timestamp >= ?
      AND gpu_index IN (${placeholders})
  `);
  const row = statement.get(runId, cutoff, ...gpuIndexes) as
    | { averageUtilization?: number | null; sampleCount?: number | null }
    | undefined;
  const sampleCount = Number(row?.sampleCount ?? 0);
  const averageUtilization = Number(row?.averageUtilization);
  if (!sampleCount || !Number.isFinite(averageUtilization)) return null;
  return {
    averageUtilization: Math.round(averageUtilization * 10) / 10,
    sampleCount
  };
}

export interface LocalNoticeInput {
  user: string;
  title: string;
  content: string;
  logTail?: string;
}

export interface QueuedLocalNotice {
  id: number;
  user: string;
  title: string;
  content: string;
  logTail?: string;
  createdAt: string;
}

const localNoticeWindowMs = 30 * 60 * 1000;
const configuredLocalNoticeQuota = Number(process.env.TENSORMESH_LOCAL_NOTICE_QUOTA ?? 3);
const localNoticeQuota = Number.isInteger(configuredLocalNoticeQuota) && configuredLocalNoticeQuota > 0 ? configuredLocalNoticeQuota : 3;

function currentQuota(user: string, now = new Date()): { windowStartedAt: string; usedCount: number; reset: boolean } {
  const row = selectLocalNoticeQuota.get(user) as { windowStartedAt?: string; usedCount?: number } | undefined;
  const windowStartedAt = row?.windowStartedAt ? new Date(row.windowStartedAt) : null;
  if (!windowStartedAt || Number.isNaN(windowStartedAt.getTime()) || now.getTime() - windowStartedAt.getTime() >= localNoticeWindowMs) {
    return { windowStartedAt: now.toISOString(), usedCount: 0, reset: true };
  }
  return { windowStartedAt: windowStartedAt.toISOString(), usedCount: Number(row?.usedCount ?? 0), reset: false };
}

export function getLocalNoticeQuotaLimit(): number {
  return localNoticeQuota;
}

export function consumeLocalNoticeQuota(user: string): boolean {
  const now = new Date();
  const quota = currentQuota(user, now);
  if (quota.usedCount >= localNoticeQuota) {
    if (quota.reset) {
      upsertLocalNoticeQuota.run(user, quota.windowStartedAt, quota.usedCount);
    }
    return false;
  }
  upsertLocalNoticeQuota.run(user, quota.windowStartedAt, quota.usedCount + 1);
  return true;
}

export function enqueueLocalNotice(input: LocalNoticeInput): QueuedLocalNotice {
  const now = new Date().toISOString();
  const result = insertLocalNotice.run(
    input.user,
    input.title,
    input.content,
    input.logTail ?? null,
    "queued",
    now,
    null
  ) as { lastInsertRowid?: bigint | number };

  return {
    id: Number(result.lastInsertRowid ?? 0),
    user: input.user,
    title: input.title,
    content: input.content,
    logTail: input.logTail,
    createdAt: now
  };
}

export function getQueuedLocalNotices(user: string, limit = 20): QueuedLocalNotice[] {
  return (selectQueuedLocalNotices.all(user, limit) as unknown as Array<{
    id: number;
    user: string;
    title: string;
    content: string;
    logTail?: string | null;
    createdAt: string;
  }>).map((row) => ({
    id: row.id,
    user: row.user,
    title: row.title,
    content: row.content,
    logTail: row.logTail ?? undefined,
    createdAt: row.createdAt
  }));
}

export function getQueuedLocalNoticeCount(user: string): number {
  const row = countQueuedLocalNotices.get(user) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

export function markLocalNoticesDelivered(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      markLocalNoticeSent.run(now, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
