export type GpuState = "idle" | "running" | "reserved" | "unknown";
export type TaskStatus = "running" | "reserved" | "finished" | "cancelled" | "stale";
export type ReservationStatus = "queued" | "armed" | "running" | "skipped" | "cancelled" | "expired";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: "member" | "admin";
}

export interface GpuProcess {
  pid: number;
  username: string;
  command: string;
  memoryUsedMb: number;
  startedAt: string;
}

export interface Task {
  id: string;
  user: string;
  project: string;
  content: string;
  command: string;
  gpuIndexes: number[];
  status: TaskStatus;
  startedAt: string;
  expectedEndAt?: string;
  endedAt?: string;
  timeNote?: string;
  taskNote?: string;
}

export interface GpuStatus {
  id: string;
  index: number;
  uuid: string;
  name: string;
  memoryTotalMb: number;
  memoryUsedMb: number;
  utilizationPercent: number;
  temperatureC: number;
  powerW: number;
  state: GpuState;
  currentTask?: Task;
  processes: GpuProcess[];
  reservation?: Reservation;
}

export interface GpuSample {
  timestamp: string;
  gpuIndex: number;
  memoryUsedMb: number;
  utilizationPercent: number;
  user?: string;
  taskId?: string;
}

export interface CpuCoreUsage {
  index: number;
  utilizationPercent: number;
}

export interface CpuStatus {
  utilizationPercent: number;
  loadAverage: [number, number, number];
  coreCount: number;
  cores: CpuCoreUsage[];
}

export interface UsageByProject {
  project: string;
  cardHours: number;
}

export interface UsageSummary {
  user: string;
  days: number;
  totalCardHours: number;
  byProject: UsageByProject[];
  daily: Array<{
    date: string;
    cardHours: number;
  }>;
}

export interface SlurmNode {
  name: string;
  state: string;
  cpus?: number;
  memoryMb?: number;
  gres?: string;
  reason?: string;
}

export interface SlurmJob {
  id: string;
  name: string;
  user: string;
  state: string;
  partition: string;
  nodes: string;
  elapsed: string;
  timeLimit: string;
  killRemaining?: string;
  killRemainingSeconds?: number;
  killAt?: string;
  reason: string;
  slurmReason?: string;
  taskDescription?: string;
  comment?: string;
  notice?: boolean;
  estimatedHours?: number;
  estimatedEndAt?: string;
  estimatedOverdue?: boolean;
  allocatedGpuIndexes?: number[];
  tres?: string;
  gres?: string;
  workDir?: string;
  command?: string;
  submittedAt?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: string;
}

export function parseSlurmDurationSeconds(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === "-" || /^(?:UNLIMITED|INFINITE|N\/A|NOT_SET)$/i.test(normalized)) {
    return undefined;
  }

  if (/^\d+$/.test(normalized)) return Number(normalized) * 60;

  const dayTime = normalized.match(/^(\d+)-(\d+)(?::(\d{2}))?(?::(\d{2}))?$/);
  if (dayTime) {
    const days = Number(dayTime[1]);
    const hours = Number(dayTime[2]);
    const minutes = Number(dayTime[3] ?? 0);
    const seconds = Number(dayTime[4] ?? 0);
    if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  }

  const hourTime = normalized.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hourTime) {
    const [, hours, minutes, seconds] = hourTime.map(Number);
    if (minutes > 59 || seconds > 59) return undefined;
    return hours * 3_600 + minutes * 60 + seconds;
  }

  const minuteTime = normalized.match(/^(\d+):(\d{2})$/);
  if (minuteTime) {
    const [, minutes, seconds] = minuteTime.map(Number);
    if (seconds > 59) return undefined;
    return minutes * 60 + seconds;
  }

  return undefined;
}

export function formatSlurmDurationSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days > 0 ? `${days}-${clock}` : clock;
}

export function getSlurmKillTiming(
  job: Pick<SlurmJob, "state" | "elapsed" | "timeLimit">,
  now = Date.now()
): Pick<SlurmJob, "killRemaining" | "killRemainingSeconds" | "killAt"> {
  const running = /^(?:RUNNING|CONFIGURING|COMPLETING|SUSPENDED|RESIZING)/i.test(job.state.trim());
  const elapsedSeconds = parseSlurmDurationSeconds(job.elapsed);
  const limitSeconds = parseSlurmDurationSeconds(job.timeLimit);
  if (!running || elapsedSeconds === undefined || limitSeconds === undefined) {
    return { killRemaining: undefined, killRemainingSeconds: undefined, killAt: undefined };
  }

  const killRemainingSeconds = Math.max(0, limitSeconds - elapsedSeconds);
  return {
    killRemaining: formatSlurmDurationSeconds(killRemainingSeconds),
    killRemainingSeconds,
    killAt: new Date(now + killRemainingSeconds * 1_000).toISOString()
  };
}

export interface SlurmJobHistoryEntry extends SlurmJob {
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
}

export interface SlurmJobHistory {
  user: string;
  days: number;
  limit: number;
  active?: boolean;
  source: "api" | "sqlite" | "sacct";
  jobs: SlurmJobHistoryEntry[];
}

export interface SlurmStatus {
  available: boolean;
  checkedAt: string;
  clusterName?: string;
  nodes: SlurmNode[];
  jobs: SlurmJob[];
  error?: string;
}

export function isActiveSlurmJobState(state: string): boolean {
  return /^(PENDING|RUNNING|CONFIGURING|COMPLETING|SUSPENDED|RESIZING|REQUEUED)/i.test(state.trim());
}

export interface Reservation {
  id: string;
  user: string;
  gpuIndexes?: number[];
  gpuCount?: number;
  project: string;
  content: string;
  command: string;
  workingDirectory: string;
  requestedStartAt: string;
  expiresAt: string;
  status: ReservationStatus;
  autoRunEnabled: boolean;
  note?: string;
}

/**
 * A shared (borrowed) task: an admin-run task that runs in parallel on a GPU
 * that is already allocated to someone else's Slurm job, without cancelling it.
 * The task runs outside Slurm in a systemd scope, and TensorMesh hides it from
 * the status display (only the original user's task is shown).
 */
export interface SharedTaskEntry {
  id: string;
  user: string;
  gpuIndexes: number[];
  /** systemd scope unit name, e.g. "shared-s-1712345678.scope" */
  scope: string;
  command: string;
  startedAt: string;
  createdBy: string;
}

export interface SharedTaskRegistryFile {
  version: 1;
  tasks: SharedTaskEntry[];
}

export interface SystemStatus {
  serverName: string;
  updatedAt: string;
  cpu?: CpuStatus;
  slurm?: SlurmStatus;
  gpus: GpuStatus[];
  tasks: Task[];
  reservations: Reservation[];
}

export const mockTasks: Task[] = [
  {
    id: "task_001",
    user: "alice",
    project: "TensorMesh",
    content: "baseline training",
    command: "CUDA_VISIBLE_DEVICES=0 python train.py --config configs/baseline.yaml",
    gpuIndexes: [0],
    status: "running",
    startedAt: "2026-05-28T00:20:00+08:00",
    expectedEndAt: "2026-05-28T08:00:00+08:00",
    timeNote: "May 28 overnight run",
    taskNote: "First baseline with 512 batch size."
  },
  {
    id: "task_002",
    user: "bob",
    project: "GeoVec",
    content: "pretraining sweep",
    command: "bash scripts/pretrain.sh --nodes 1 --gpus 2",
    gpuIndexes: [1, 2],
    status: "running",
    startedAt: "2026-05-27T22:10:00+08:00",
    expectedEndAt: "2026-05-28T10:30:00+08:00",
    timeNote: "May 27 night to May 28 morning",
    taskNote: "Two-card sweep; expected to finish before group meeting."
  }
];

export const mockReservations: Reservation[] = [
  {
    id: "res_001",
    user: "carol",
    gpuIndexes: [3],
    project: "DiffusionEval",
    content: "sample generation",
    command: "CUDA_VISIBLE_DEVICES=3 bash run_samples.sh",
    workingDirectory: "/data/carol/diffusion-eval",
    requestedStartAt: "2026-05-28T09:30:00+08:00",
    expiresAt: "2026-05-28T18:00:00+08:00",
    status: "queued",
    autoRunEnabled: false,
    note: "Can start automatically after dry-run policy is enabled."
  }
];

export function getMockSystemStatus(now = new Date()): SystemStatus {
  const updatedAt = now.toISOString();
  const [task0, task1] = mockTasks;
  const reservation = mockReservations[0];

  return {
    serverName: "gpu-node-01",
    updatedAt,
    cpu: getMockCpuStatus(now),
    tasks: mockTasks,
    reservations: mockReservations,
    gpus: [
      {
        id: "gpu_0",
        index: 0,
        uuid: "GPU-0000",
        name: "NVIDIA A100-SXM4-40GB",
        memoryTotalMb: 40960,
        memoryUsedMb: 23110,
        utilizationPercent: 92,
        temperatureC: 64,
        powerW: 274,
        state: "running",
        currentTask: task0,
        processes: [
          {
            pid: 18421,
            username: "alice",
            command: "python train.py --config configs/baseline.yaml",
            memoryUsedMb: 22980,
            startedAt: task0.startedAt
          }
        ]
      },
      {
        id: "gpu_1",
        index: 1,
        uuid: "GPU-0001",
        name: "NVIDIA A100-SXM4-40GB",
        memoryTotalMb: 40960,
        memoryUsedMb: 38800,
        utilizationPercent: 98,
        temperatureC: 69,
        powerW: 303,
        state: "running",
        currentTask: task1,
        processes: [
          {
            pid: 22018,
            username: "bob",
            command: "python pretrain.py --rank 0",
            memoryUsedMb: 38720,
            startedAt: task1.startedAt
          }
        ]
      },
      {
        id: "gpu_2",
        index: 2,
        uuid: "GPU-0002",
        name: "NVIDIA A100-SXM4-40GB",
        memoryTotalMb: 40960,
        memoryUsedMb: 37440,
        utilizationPercent: 91,
        temperatureC: 67,
        powerW: 291,
        state: "running",
        currentTask: task1,
        processes: [
          {
            pid: 22019,
            username: "bob",
            command: "python pretrain.py --rank 1",
            memoryUsedMb: 37380,
            startedAt: task1.startedAt
          }
        ]
      },
      {
        id: "gpu_3",
        index: 3,
        uuid: "GPU-0003",
        name: "NVIDIA A100-SXM4-40GB",
        memoryTotalMb: 40960,
        memoryUsedMb: 1180,
        utilizationPercent: 2,
        temperatureC: 38,
        powerW: 61,
        state: "reserved",
        processes: [],
        reservation
      }
    ]
  };
}

export function getMockCpuStatus(now = new Date()): CpuStatus {
  const coreCount = 16;
  const minute = Math.floor(now.getTime() / 60_000);
  const cores = Array.from({ length: coreCount }, (_, index) => {
    const wave = Math.abs(Math.sin((minute + index * 1.7) / 5));
    return {
      index,
      utilizationPercent: Math.round(10 + wave * 68)
    };
  });
  const average =
    cores.reduce((total, core) => total + core.utilizationPercent, 0) / Math.max(cores.length, 1);

  return {
    utilizationPercent: Math.round(average),
    loadAverage: [
      Math.round((average / 100) * coreCount * 100) / 100,
      Math.round((average / 100) * coreCount * 0.86 * 100) / 100,
      Math.round((average / 100) * coreCount * 0.74 * 100) / 100
    ],
    coreCount,
    cores
  };
}

export function getMockGpuHistory(gpuIndex: number, days = 14): GpuSample[] {
  const points = Math.min(days * 24, 14 * 24);
  const now = Date.now();

  return Array.from({ length: points }, (_, offset) => {
    const age = points - offset - 1;
    const timestamp = new Date(now - age * 60 * 60 * 1000).toISOString();
    const active = gpuIndex !== 3 || offset > points - 10;
    const wave = Math.abs(Math.sin((offset + gpuIndex) / 5));

    return {
      timestamp,
      gpuIndex,
      memoryUsedMb: active ? Math.round(12000 + wave * 26000) : Math.round(800 + wave * 600),
      utilizationPercent: active ? Math.round(35 + wave * 63) : Math.round(wave * 5),
      user: active ? (gpuIndex === 0 ? "alice" : gpuIndex === 3 ? "carol" : "bob") : undefined,
      taskId: active ? (gpuIndex === 0 ? "task_001" : gpuIndex === 3 ? "res_001" : "task_002") : undefined
    };
  });
}

export function getMockUsageSummary(user: string, days = 14): UsageSummary {
  const base = user === "bob" ? 58.5 : user === "alice" ? 31.25 : 6.5;
  const today = new Date();

  return {
    user,
    days,
    totalCardHours: base,
    byProject: [
      { project: user === "bob" ? "GeoVec" : "TensorMesh", cardHours: Math.round(base * 0.72 * 100) / 100 },
      { project: "Ablation", cardHours: Math.round(base * 0.28 * 100) / 100 }
    ],
    daily: Array.from({ length: days }, (_, offset) => {
      const date = new Date(today.getTime() - (days - offset - 1) * 24 * 60 * 60 * 1000);
      const value = Math.max(0, Math.sin(offset / 2) * 3 + base / days);

      return {
        date: date.toISOString().slice(0, 10),
        cardHours: Math.round(value * 100) / 100
      };
    })
  };
}

export function formatMemory(usedMb: number, totalMb: number): string {
  return `${Math.round(usedMb / 1024)} / ${Math.round(totalMb / 1024)} GB`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
