import { Component, type CSSProperties, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Command,
  Cpu,
  FileText,
  Download,
  Eye,
  Files,
  FolderOpen,
  LogOut,
  Mail,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  TerminalSquare,
  UploadCloud,
  X,
  XCircle,
  UserRound
} from "lucide-react";
import {
  formatMemory,
  formatPercent,
  getSlurmKillTiming,
  getMockGpuHistory,
  getMockSystemStatus,
  getMockUsageSummary,
  type GpuSample,
  type GpuStatus,
  type Reservation,
  type SlurmJob,
  type SystemStatus,
  type Task,
  type UsageSummary
} from "@tensormesh/shared";
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const apiBase = "";

type HistoryRangeId = "30m" | "2h" | "6h" | "24h" | "7d" | "14d" | "custom";

type HistoryQuery = {
  from: string;
  to: string;
  bucketSeconds: number;
  smoothingWindow: number;
  spanMs: number;
};

type HistoryBrushSelection = {
  scopeKey: string;
  startTime: number;
  endTime: number;
};

const historyRangeOptions: Array<{ value: HistoryRangeId; label: string; ms?: number }> = [
  { value: "30m", label: "最近 30 分钟", ms: 30 * 60 * 1000 },
  { value: "2h", label: "最近 2 小时", ms: 2 * 60 * 60 * 1000 },
  { value: "6h", label: "最近 6 小时", ms: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "最近 24 小时", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "最近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "14d", label: "最近 14 天", ms: 14 * 24 * 60 * 60 * 1000 },
  { value: "custom", label: "自定义时间段" }
];

function getHistoryRange(rangeId: HistoryRangeId) {
  return historyRangeOptions.find((option) => option.value === rangeId) ?? historyRangeOptions[1];
}

function historyBucketSeconds(spanMs: number): number {
  const targetPoints = 140;
  const rawSeconds = Math.ceil(spanMs / targetPoints / 1000);
  const candidates = [30, 60, 180, 300, 600, 1800, 3600, 7200];
  return candidates.find((seconds) => seconds >= rawSeconds) ?? 7200;
}

function historySmoothingWindow(spanMs: number): number {
  if (spanMs <= 45 * 60 * 1000) return 3;
  if (spanMs <= 8 * 60 * 60 * 1000) return 5;
  if (spanMs <= 36 * 60 * 60 * 1000) return 3;
  return 1;
}

function buildHistoryQuery(rangeId: HistoryRangeId, customFrom: string, customTo: string): HistoryQuery {
  const now = new Date();
  const selectedRange = getHistoryRange(rangeId);
  const toDate = rangeId === "custom" ? new Date(customTo) : now;
  const fromDate = rangeId === "custom" ? new Date(customFrom) : new Date(now.getTime() - (selectedRange.ms ?? 2 * 60 * 60 * 1000));
  const isValidRange = Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime()) && fromDate < toDate;
  const safeTo = isValidRange ? toDate : now;
  const safeFrom = isValidRange ? fromDate : new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const spanMs = safeTo.getTime() - safeFrom.getTime();

  return {
    from: safeFrom.toISOString(),
    to: safeTo.toISOString(),
    bucketSeconds: historyBucketSeconds(spanMs),
    smoothingWindow: historySmoothingWindow(spanMs),
    spanMs
  };
}

function formatBucket(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds / 3600)} 小时`;
}

function formatHistoryTick(value: number, spanMs: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  if (spanMs > 36 * 60 * 60 * 1000) {
    return date.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatHistoryTooltipTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function killRemainingSeconds(job: SlurmJob): number | undefined {
  return job.killRemainingSeconds ?? getSlurmKillTiming(job).killRemainingSeconds;
}

function formatKillCountdown(job: SlurmJob): string {
  const total = killRemainingSeconds(job);
  if (total !== undefined) {
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = Math.floor(total % 60);
    if (days > 0) return `${days}天 ${hours}小时 ${minutes}分`;
    if (hours > 0) return `${hours}小时 ${minutes}分`;
    if (minutes > 0) return `${minutes}分 ${seconds}秒`;
    return `${seconds}秒`;
  }
  if (/PENDING|REQUEUED/i.test(job.state)) return "等待分配资源";
  return "无活动倒计时";
}

function formatKillAt(job: SlurmJob): string {
  const killAt = job.killAt ?? getSlurmKillTiming(job).killAt;
  if (killAt) return new Date(killAt).toLocaleString();
  if (/PENDING|REQUEUED/i.test(job.state)) return `启动后最多运行 ${job.timeLimit}`;
  return `硬限制 ${job.timeLimit}`;
}

interface SessionInfo {
  user: string;
  expiresAt?: string;
  settings: {
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
  };
  mail?: {
    configured: boolean;
    endpoint: string;
    fromName: string;
    tokenSource: "env" | "file" | "missing";
    tokenFile?: string;
  };
}

interface JobLogPayload {
  jobId: string;
  path: string | null;
  content: string;
}

function currentToken(): string {
  const params = new URLSearchParams(window.location.search);
  const rawQuery = window.location.search.startsWith("?") ? window.location.search.slice(1) : "";
  const rawToken = rawQuery && !rawQuery.includes("=") ? decodeURIComponent(rawQuery) : "";
  const token = params.get("token") ?? params.get("t") ?? rawToken;
  if (token && (!params.get("token") || rawToken || window.location.pathname === "/tokens")) {
    const next = new URL(window.location.href);
    next.pathname = "/";
    next.search = "";
    next.searchParams.delete("t");
    next.searchParams.set("token", token);
    window.history.replaceState(null, "", next);
  }
  return token;
}

const webToken = currentToken();

function withToken(path: string): string {
  if (!webToken) return `${apiBase}${path}`;
  const url = new URL(`${apiBase}${path}`, window.location.origin);
  url.searchParams.set("token", webToken);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (webToken) headers.set("authorization", `Bearer ${webToken}`);
  return fetch(withToken(path), { ...init, headers });
}

async function fetchStatus(): Promise<SystemStatus> {
  const response = await apiFetch("/api/status");
  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }
  return response.json() as Promise<SystemStatus>;
}

async function fetchGpuHistory(gpuIndex: number, query: HistoryQuery): Promise<GpuSample[]> {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    limit: "1200",
    bucketSeconds: String(query.bucketSeconds)
  });
  const response = await apiFetch(`/api/gpus/${gpuIndex}/history?${params}`);
  if (!response.ok) {
    throw new Error(`History API returned ${response.status}`);
  }

  const payload = (await response.json()) as { samples: GpuSample[] };
  return payload.samples;
}

async function fetchUsage(user: string): Promise<UsageSummary> {
  const response = await apiFetch(`/api/users/${encodeURIComponent(user)}/usage?days=14`);
  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}`);
  }

  return response.json() as Promise<UsageSummary>;
}

async function fetchUsers(): Promise<string[]> {
  const response = await apiFetch("/api/users");
  if (!response.ok) {
    throw new Error(`Users API returned ${response.status}`);
  }

  return response.json() as Promise<string[]>;
}

function downloadCsv(path: string) {
  window.location.href = withToken(path);
}

function tokenLoginTarget(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const next = new URL(window.location.href);
  next.pathname = window.location.pathname === "/upload" || window.location.pathname.startsWith("/upload/")
    ? window.location.pathname
    : "/";
  next.search = "";
  next.searchParams.set("token", trimmed);
  return `${next.pathname}${next.search}`;
}

interface TestMailPayload {
  ok: boolean;
  status: number;
  body: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchSession(): Promise<SessionInfo> {
  const response = await apiFetch("/api/session");
  if (!response.ok) throw new Error(`Session API returned ${response.status}`);
  return response.json() as Promise<SessionInfo>;
}

async function fetchJobLog(jobId: string): Promise<JobLogPayload> {
  const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/log?maxBytes=65536`);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `Log API returned ${response.status}`);
  }
  return response.json() as Promise<JobLogPayload>;
}

function sessionSettingsClamp(settings: SessionInfo["settings"]): SessionInfo["settings"] {
  const lowGpuMinutes = Number(settings.lowGpuMinutes);
  const lowGpuThreshold = Number(settings.lowGpuThreshold);
  return {
    ...settings,
    noticeMode: settings.noticeMode === "global" ? "global" : "explicit",
    lowGpuMinutes: Math.max(1, Math.min(1440, Math.round(Number.isFinite(lowGpuMinutes) ? lowGpuMinutes : 30))),
    lowGpuThreshold: Math.max(1, Math.min(100, Math.round(Number.isFinite(lowGpuThreshold) ? lowGpuThreshold : 50)))
  };
}

function toDatetimeLocal(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

function stateTone(state: GpuStatus["state"]) {
  if (state === "running") return "running";
  if (state === "idle") return "idle";
  if (state === "reserved") return "reserved";
  return "warning";
}

function stateLabel(state: GpuStatus["state"]) {
  if (state === "running") return "运行中";
  if (state === "idle") return "空闲";
  if (state === "reserved") return "已占用";
  return "未知";
}

function cpuHeatStyle(utilizationPercent: number, available: boolean): CSSProperties {
  const value = Math.max(0, Math.min(100, utilizationPercent));
  const hue = Math.max(0, 152 - value * 1.35);
  const saturation = 42 + value * 0.36;
  const light = Math.max(28, 94 - value * 0.46);
  const foreground = value >= 72 ? "#ffffff" : "#111111";

  return {
    color: foreground,
    opacity: available ? 1 : 0.22,
    borderColor: `hsl(${hue} ${Math.min(88, saturation)}% ${Math.max(34, light - 10)}%)`,
    background: available
      ? `linear-gradient(135deg, hsl(${hue} ${Math.min(88, saturation)}% ${light}%), hsl(${Math.max(0, hue - 18)} ${Math.min(92, saturation + 8)}% ${Math.max(30, light - 12)}%))`
      : "#f5f5f5"
  };
}

interface GpuHistoryLine {
  gpuIndex: number;
  samples: GpuSample[];
  color: string;
  smoothingWindow: number;
}

const chartColors = ["#090909", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#525252", "#0891b2"];
const maxChartSamples = 1200;
const emptyStatus: SystemStatus = {
  serverName: "TensorMesh",
  updatedAt: new Date().toISOString(),
  gpus: [],
  tasks: [],
  reservations: []
};

type HistoryChartPoint = {
  timestamp: string;
  time: number;
  [key: `gpu${number}`]: number | string;
  [key: `gpu${number}Util`]: number | string;
};

function buildHistoryChartData(lines: GpuHistoryLine[], query: HistoryQuery): HistoryChartPoint[] {
  const byTimestamp = new Map<string, HistoryChartPoint>();
  const fromTime = new Date(query.from).getTime();
  const toTime = new Date(query.to).getTime();
  const validSamples: Array<{ line: GpuHistoryLine; sample: GpuSample; time: number }> = [];

  for (const line of lines) {
    const smoothedSamples = smoothGpuSamples(line.samples, line.smoothingWindow);
    for (const sample of smoothedSamples) {
      const time = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(sample.memoryUsedMb) || !Number.isFinite(time)) continue;
      if (Number.isFinite(fromTime) && time < fromTime) continue;
      if (Number.isFinite(toTime) && time > toTime) continue;
      validSamples.push({ line, sample, time });
    }
  }

  for (const { line, sample } of validSamples) {
    const point = byTimestamp.get(sample.timestamp) ?? {
      timestamp: sample.timestamp,
      time: new Date(sample.timestamp).getTime()
    };

    point[`gpu${line.gpuIndex}`] = Math.round((sample.memoryUsedMb / 1024) * 10) / 10;
    point[`gpu${line.gpuIndex}Util`] = Math.round(sample.utilizationPercent);
    byTimestamp.set(sample.timestamp, point);
  }

  const points = Array.from(byTimestamp.values())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-maxChartSamples);

  if (Number.isFinite(fromTime)) {
    points.unshift({ timestamp: new Date(fromTime).toISOString(), time: fromTime });
  }
  if (Number.isFinite(toTime)) {
    points.push({ timestamp: new Date(toTime).toISOString(), time: toTime });
  }

  return points;
}

function smoothGpuSamples(samples: GpuSample[], windowSize: number): GpuSample[] {
  if (windowSize <= 1 || samples.length <= 2) return samples;

  return samples.map((sample, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = samples.slice(start, index + 1);
    const memoryUsedMb = window.reduce((sum, item) => sum + item.memoryUsedMb, 0) / window.length;
    const utilizationPercent = window.reduce((sum, item) => sum + item.utilizationPercent, 0) / window.length;

    return {
      ...sample,
      memoryUsedMb: Math.round(memoryUsedMb),
      utilizationPercent: Math.round(utilizationPercent)
    };
  });
}

interface ChartTooltipItem {
  dataKey?: string | number;
  color?: string;
  name?: string;
  value?: number;
  unit?: string;
}

function HistoryTooltip({
  active,
  payload,
  label
}: {
  active?: boolean;
  payload?: ChartTooltipItem[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{formatHistoryTooltipTime(Number(label))}</div>
      {payload.map((item) => (
        <div className="chart-tooltip-row" key={item.dataKey}>
          <span style={{ background: item.color }} />
          <strong>{item.name}</strong>
          <em>{String(item.dataKey).endsWith("Util") ? `${item.value?.toFixed(0)}%` : `${item.value?.toFixed(1)} GB`}</em>
        </div>
      ))}
    </div>
  );
}

function GpuHistoryChart({
  lines,
  highlightedGpu,
  query,
  brushScopeKey,
  brushSelection,
  onBrushSelectionChange
}: {
  lines: GpuHistoryLine[];
  highlightedGpu: number | null;
  query: HistoryQuery;
  brushScopeKey: string;
  brushSelection: HistoryBrushSelection | null;
  onBrushSelectionChange: (selection: HistoryBrushSelection | null) => void;
}) {
  const chartData = useMemo(() => buildHistoryChartData(lines, query), [lines, query]);
  const activeBrush = brushSelection?.scopeKey === brushScopeKey ? brushSelection : null;
  const visibleIndexes = useMemo(() => {
    if (!activeBrush || chartData.length === 0) {
      return { startIndex: 0, endIndex: Math.max(0, chartData.length - 1) };
    }

    const startIndex = chartData.findIndex((point) => point.time >= activeBrush.startTime);
    const endIndexFromEnd = [...chartData].reverse().findIndex((point) => point.time <= activeBrush.endTime);
    return {
      startIndex: Math.max(0, startIndex === -1 ? 0 : startIndex),
      endIndex: Math.max(0, endIndexFromEnd === -1 ? chartData.length - 1 : chartData.length - 1 - endIndexFromEnd)
    };
  }, [activeBrush, chartData]);

  return (
    <div className="history-chart">
      {chartData.length === 0 ? (
        <div className="history-empty">暂无该时间范围内的历史数据</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 18, left: 0 }}>
            <CartesianGrid stroke="#e5e5e5" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              domain={[new Date(query.from).getTime(), new Date(query.to).getTime()]}
              tickFormatter={(value) => formatHistoryTick(Number(value), query.spanMs)}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
              tick={{ fill: "#737373", fontSize: 12 }}
            />
            <YAxis
              yAxisId="memory"
              tickLine={false}
              axisLine={false}
              width={54}
              tickFormatter={(value) => `${value}G`}
              label={{ value: "显存", angle: -90, position: "insideLeft", fill: "#737373", fontSize: 12 }}
              tick={{ fill: "#737373", fontSize: 12 }}
            />
            <YAxis
              yAxisId="util"
              orientation="right"
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              width={46}
              tickFormatter={(value) => `${value}%`}
              label={{ value: "利用率", angle: 90, position: "insideRight", fill: "#737373", fontSize: 12 }}
              tick={{ fill: "#737373", fontSize: 12 }}
            />
            <Tooltip content={<HistoryTooltip />} />
            <Legend
              verticalAlign="top"
              height={34}
              iconType="plainline"
              wrapperStyle={{ fontSize: 11, lineHeight: "18px", paddingBottom: 6 }}
            />
            {lines.map((line) => (
              <Line
                key={line.gpuIndex}
                type="monotone"
                dataKey={`gpu${line.gpuIndex}`}
                name={`GPU ${line.gpuIndex} 显存`}
                yAxisId="memory"
                stroke={line.color}
                strokeWidth={highlightedGpu === line.gpuIndex ? 3 : 2}
                dot={false}
                activeDot={{ r: 4 }}
                opacity={highlightedGpu === null || highlightedGpu === line.gpuIndex ? 1 : 0.25}
                isAnimationActive={false}
                connectNulls
              />
            ))}
            {lines.map((line) => (
              <Line
                key={`${line.gpuIndex}-util`}
                type="monotone"
                dataKey={`gpu${line.gpuIndex}Util`}
                name={`GPU ${line.gpuIndex} 利用率`}
                yAxisId="util"
                stroke={line.color}
                strokeDasharray="4 4"
                strokeWidth={highlightedGpu === line.gpuIndex ? 2 : 1.5}
                dot={false}
                activeDot={{ r: 3 }}
                opacity={highlightedGpu === null || highlightedGpu === line.gpuIndex ? 0.72 : 0.18}
                isAnimationActive={false}
                connectNulls
              />
            ))}
            <Brush
              dataKey="time"
              height={22}
              startIndex={visibleIndexes.startIndex}
              endIndex={visibleIndexes.endIndex}
              travellerWidth={8}
              stroke="#525252"
              fill="#ffffff"
              tickFormatter={(value) => formatHistoryTick(Number(value), query.spanMs)}
              onChange={(range) => {
                if (range?.startIndex == null || range.endIndex == null) return;
                const startPoint = chartData[range.startIndex];
                const endPoint = chartData[range.endIndex];
                if (!startPoint || !endPoint) return;
                const fullStart = new Date(query.from).getTime();
                const fullEnd = new Date(query.to).getTime();
                const isFullRange = range.startIndex <= 0 && range.endIndex >= chartData.length - 1;
                onBrushSelectionChange(isFullRange ? null : {
                  scopeKey: brushScopeKey,
                  startTime: Math.max(fullStart, startPoint.time),
                  endTime: Math.min(fullEnd, endPoint.time)
                });
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("TensorMesh UI error", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-shell">
          <section className="panel error-panel">
            <h1>TensorMesh 页面渲染失败</h1>
            <p>{this.state.error.message}</p>
            <Button onClick={() => window.location.reload()}>重新加载</Button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

function MetricPill({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GpuRow({ gpu }: { gpu: GpuStatus }) {
  const processUsers = gpu.processes.map((process) => process.username).filter(Boolean);
  const owners = Array.from(new Set([
    gpu.currentTask?.user,
    gpu.reservation?.user,
    ...processUsers
  ].filter(Boolean) as string[]));
  const owner = owners.length > 0 ? owners.join(", ") : "-";
  const task = gpu.currentTask
    ? `${gpu.currentTask.project} - ${gpu.currentTask.content}`
    : gpu.reservation
      ? `${gpu.reservation.project} - ${gpu.reservation.content}`
      : "-";
  const isSlurmAllocated = gpu.currentTask?.id.startsWith("slurm_") && gpu.processes.every((process) => process.pid === 0);
  const processCount = gpu.processes.filter((process) => process.pid > 0).length;

  return (
    <div className="gpu-row">
      <div className="gpu-main">
        <div className="gpu-index">GPU {gpu.index}</div>
        <div>
          <div className="gpu-name">{gpu.name}</div>
          <div className="gpu-uuid">{gpu.uuid}</div>
        </div>
      </div>

      <div className="gpu-meter">
        <div className="meter-label">
          <span>显存</span>
          <strong>{formatMemory(gpu.memoryUsedMb, gpu.memoryTotalMb)}</strong>
        </div>
        <Progress value={(gpu.memoryUsedMb / gpu.memoryTotalMb) * 100} />
      </div>

      <div className="gpu-meter">
        <div className="meter-label">
          <span>利用率</span>
          <strong>{formatPercent(gpu.utilizationPercent)}</strong>
        </div>
        <Progress value={gpu.utilizationPercent} />
      </div>

      <div className="gpu-meta">
        <span>{owner}</span>
        <strong>{task}</strong>
        {isSlurmAllocated ? <small>Slurm 已分配，当前无 GPU 进程</small> : processCount > 0 ? <small>{processCount} 个 GPU 进程</small> : null}
      </div>

      <Badge tone={stateTone(gpu.state)}>{stateLabel(gpu.state)}</Badge>
    </div>
  );
}

function ReservationQueue({ status }: { status: SystemStatus }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>预约队列</h2>
          <p>当前阶段记录预约和 dry-run 信息，自动执行默认关闭。</p>
        </div>
      </div>
      <div className="reservation-list">
        {status.reservations.length === 0 ? <p>当前没有预约。</p> : null}
        {status.reservations.map((reservation) => (
          <div className="reservation-item" key={reservation.id}>
            <div>
              <div className="reservation-title">
                <strong>{reservation.user}</strong>
                <span>{reservation.project} - {reservation.content}</span>
              </div>
              <code>{reservation.command}</code>
            </div>
            <div className="reservation-time">
              <span>{new Date(reservation.requestedStartAt).toLocaleString()}</span>
              <Badge tone="reserved">{reservation.status}</Badge>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function UsagePanel({
  usage,
  users,
  selectedUser,
  onSelectedUserChange,
  cpu
}: {
  usage: UsageSummary;
  users: string[];
  selectedUser: string;
  onSelectedUserChange: (user: string) => void;
  cpu?: SystemStatus["cpu"];
}) {
  const usageTotal = Math.max(usage.totalCardHours, 0.001);
  const busiestCores = [...(cpu?.cores ?? [])]
    .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
    .slice(0, 8);
  const coreByIndex = new Map((cpu?.cores ?? []).map((core) => [core.index, core]));
  const cpuCells = Array.from({ length: 64 }, (_, index) => {
    const core = coreByIndex.get(index);
    return {
      index,
      available: Boolean(core),
      utilizationPercent: core?.utilizationPercent ?? 0
    };
  });
  const projectLabel = (project: string) => (project === "未登记" ? "未登记进程" : project);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>用户卡时</h2>
          <p>最近 {usage.days} 天，按真实进程区间优先统计。</p>
        </div>
        <Select value={selectedUser} onValueChange={onSelectedUserChange}>
          <SelectTrigger className="usage-user-select" aria-label="选择用户">
            <SelectValue placeholder="选择用户" />
          </SelectTrigger>
          <SelectContent>
            {users.length === 0 ? <SelectItem value={selectedUser}>{selectedUser}</SelectItem> : null}
            {users.map((user) => (
              <SelectItem key={user} value={user}>
                {user}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="usage-total">
        <span>总卡时</span>
        <strong>{usage.totalCardHours.toFixed(2)} card-hours</strong>
        <small>按 GPU 进程采样累计；未登记表示没有任务描述或项目归属的进程。</small>
      </div>
      <div className="usage-bars">
        {usage.byProject.length === 0 ? <p>当前服务运行期间还没有可统计的卡时。</p> : null}
        {usage.byProject.map((item) => (
          <div className="usage-bar" key={item.project}>
            <div>
              <span>{projectLabel(item.project)}</span>
              <strong>{item.cardHours.toFixed(2)} card-hours</strong>
            </div>
            <Progress value={(item.cardHours / usageTotal) * 100} />
          </div>
        ))}
      </div>
      <div className="cpu-detail">
        <div className="cpu-detail-header">
          <div>
            <h3>CPU 使用详情</h3>
            <p>{cpu ? `${cpu.coreCount} 核心，Load ${cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ")}` : "等待采样"}</p>
          </div>
          <Badge tone={cpu && cpu.utilizationPercent >= 85 ? "warning" : "idle"}>
            <Activity size={12} />
            {cpu ? formatPercent(cpu.utilizationPercent) : "--"}
          </Badge>
        </div>
        {cpu ? (
          <>
            <div className="cpu-heatmap" aria-label="CPU 8x8 使用率热力图">
              {cpuCells.map((core) => (
                <div
                  className="cpu-heat-cell"
                  key={core.index}
                  style={cpuHeatStyle(core.utilizationPercent, core.available)}
                  title={`CPU ${core.index}: ${core.available ? formatPercent(core.utilizationPercent) : "未采样"}`}
                >
                  <span>{core.index}</span>
                  <strong>{core.available ? Math.round(core.utilizationPercent) : "-"}</strong>
                </div>
              ))}
            </div>
            {busiestCores.length > 0 ? (
              <div className="cpu-hot-list">
                <span>高占用核心</span>
                <strong>{busiestCores.map((core) => `CPU ${core.index} ${formatPercent(core.utilizationPercent)}`).join(" · ")}</strong>
              </div>
            ) : null}
          </>
        ) : (
          <p className="cpu-empty">当前 API 未返回 CPU 采样。</p>
        )}
      </div>
    </section>
  );
}

function SessionPanel({
  session,
  settingsDraft,
  onSettingsChange,
  onAutoSave,
  onSave,
  onTestMail,
  testMailBusy,
  error
}: {
  session: SessionInfo | null;
  settingsDraft: SessionInfo["settings"];
  onSettingsChange: (settings: SessionInfo["settings"]) => void;
  onAutoSave: (settings: SessionInfo["settings"]) => void;
  onSave: () => void;
  onTestMail: () => void;
  testMailBusy: boolean;
  error: string | null;
}) {
  const setDraft = (patch: Partial<SessionInfo["settings"]>) => {
    onSettingsChange({ ...settingsDraft, ...patch });
  };
  const setAndSave = (patch: Partial<SessionInfo["settings"]>) => {
    const next = { ...settingsDraft, ...patch };
    onSettingsChange(next);
    onAutoSave(next);
  };

  return (
    <section className="panel session-panel">
      <div className="panel-header">
        <div>
          <h2>个人入口</h2>
          <p>当前链接由 CLI 生成，用于识别访问者身份，不需要密码登录。</p>
        </div>
        <Badge tone={session ? "idle" : "warning"}>
          <UserRound size={12} />
          {session?.user ?? "未识别"}
        </Badge>
      </div>
      <div className="session-grid">
        <label>
          提醒邮箱
          <div className="session-email-row">
            <Input value={settingsDraft.reminderEmail ?? ""} onChange={(event) => setDraft({ reminderEmail: event.target.value })} placeholder="name@example.com" />
            <Button type="button" variant="secondary" onClick={onSave}>
              <Mail size={16} />
              保存
            </Button>
            <Button type="button" variant="secondary" onClick={onTestMail} disabled={testMailBusy || !settingsDraft.reminderEmail?.trim()}>
              <Mail size={16} />
              {testMailBusy ? "发送中" : "测试"}
            </Button>
          </div>
        </label>
        <div className="session-meta">
          <span>Token 到期</span>
          <strong>{session?.expiresAt ? new Date(session.expiresAt).toLocaleString() : "本机访问"}</strong>
        </div>
        <div className="session-meta">
          <span>邮件服务</span>
          <strong>{session?.mail?.configured ? `${session.mail.fromName} · ${session.mail.tokenSource}` : "未配置"}</strong>
        </div>
      </div>
      <div className="reminder-settings">
        <div className="reminder-settings-header">
          <div>
            <h3>邮件提醒内容</h3>
            <p>选项会自动保存。显式模式下只有带 <code>--notice</code> 的任务才会发提醒。</p>
          </div>
          <Select value={settingsDraft.noticeMode} onValueChange={(value) => setAndSave({ noticeMode: value === "global" ? "global" : "explicit" })}>
            <SelectTrigger aria-label="提醒发送模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="explicit">显式发送</SelectItem>
              <SelectItem value="global">全局发送</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="check-row">
          <Checkbox checked={settingsDraft.notifyJobFinished} onCheckedChange={(checked) => setAndSave({ notifyJobFinished: checked === true })} />
          <span>job 自然完成退出提醒</span>
        </label>
        <label className="check-row">
          <Checkbox checked={settingsDraft.notifyReservationStarted} onCheckedChange={(checked) => setAndSave({ notifyReservationStarted: checked === true })} />
          <span>预约的 job 开始自动运行提醒</span>
        </label>
        <label className="check-row">
          <Checkbox checked={settingsDraft.notifyJobOverdue} onCheckedChange={(checked) => setAndSave({ notifyJobOverdue: checked === true })} />
          <span>job 超过 100% 预计时间仍未结束提醒</span>
        </label>
        <div className="threshold-row">
          <label className="check-row">
            <Checkbox checked={settingsDraft.notifyLowGpu} onCheckedChange={(checked) => setAndSave({ notifyLowGpu: checked === true })} />
            <span>GPU 低利用率提醒</span>
          </label>
          <div className="threshold-controls">
            <label>
              观察窗口
              <Input
                type="number"
                min={1}
                max={1440}
                value={settingsDraft.lowGpuMinutes}
                onChange={(event) => setDraft({ lowGpuMinutes: Number(event.target.value) })}
                onBlur={() => onAutoSave(sessionSettingsClamp(settingsDraft))}
              />
              <span>分钟</span>
            </label>
            <label>
              平均低于
              <Input
                type="number"
                min={1}
                max={100}
                value={settingsDraft.lowGpuThreshold}
                onChange={(event) => setDraft({ lowGpuThreshold: Number(event.target.value) })}
                onBlur={() => onAutoSave(sessionSettingsClamp(settingsDraft))}
              />
              <span>%</span>
            </label>
          </div>
        </div>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

const defaultSessionSettings: SessionInfo["settings"] = {
  user: "",
  reminderEmail: "",
  notifyJobFinished: false,
  notifyReservationStarted: false,
  notifyJobOverdue: false,
  notifyLowGpu: false,
  noticeMode: "explicit",
  lowGpuMinutes: 30,
  lowGpuThreshold: 50
};

function TokenLogin() {
  const [tokenInput, setTokenInput] = useState("");
  const target = tokenLoginTarget(tokenInput);
  const isUploadLogin = window.location.pathname.startsWith("/upload/");

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand">
          <Server size={18} />
          <span>TensorMesh</span>
        </div>
        <div>
          <h1>输入访问 token</h1>
          <p>{isUploadLogin
            ? <>请粘贴 <code>tmesh upload</code> 命令生成的临时上传 token。</>
            : <>请从服务器终端执行 <code>tmesh web</code> 获取个人访问链接，或将链接中的 token 粘贴到这里。</>}</p>
        </div>
        <form
          className="token-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (target) window.location.href = target;
          }}
        >
          <Input
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="粘贴 token"
            autoFocus
          />
          <Button type="submit" disabled={!target}>
            登录
          </Button>
        </form>
        <p className="login-hint">{isUploadLogin
          ? "token 仅允许访问这次临时上传会话，并会随会话一起过期。"
          : <>直连地址也支持 <code>/tokens?token</code> 格式，页面会自动转换为带 token 的访问入口。</>}</p>
      </section>
    </main>
  );
}

type UploadState = "queued" | "uploading" | "complete" | "error";

interface UploadQueueItem {
  id: string;
  file: File;
  state: UploadState;
  progress: number;
  savedName?: string;
  message?: string;
}

interface UploadResult {
  ok: true;
  name: string;
  size: number;
  user: string;
}

interface UploadSessionInfo {
  id: string;
  user: string;
  directory: string;
  createdAt: string;
  expiresAt: string;
  pid: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function uploadFile(sessionId: string, file: File, onProgress: (progress: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", withToken(`/upload-api/${encodeURIComponent(sessionId)}/files`));
    request.setRequestHeader("authorization", `Bearer ${webToken}`);
    request.setRequestHeader("x-tensormesh-file-name", encodeURIComponent(file.name));
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let payload: (UploadResult & { message?: string }) | null = null;
      try {
        payload = JSON.parse(request.responseText) as UploadResult & { message?: string };
      } catch {
        // The status text below is enough when the response is not JSON.
      }
      if (request.status >= 200 && request.status < 300 && payload?.ok) {
        resolve(payload);
        return;
      }
      reject(new Error(payload?.message ?? `上传失败（HTTP ${request.status || 0}）`));
    });
    request.addEventListener("error", () => reject(new Error("网络连接中断")));
    request.addEventListener("abort", () => reject(new Error("上传已取消")));
    request.send(file);
  });
}

function UploadResolver() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/upload-api/resolve")
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as (UploadSessionInfo & { message?: string }) | null;
        if (!response.ok || !payload?.id) throw new Error(payload?.message ?? `API returned ${response.status}`);
        return payload;
      })
      .then((session) => {
        if (!cancelled) {
          window.location.replace(`/upload/${session.id}?token=${encodeURIComponent(webToken)}`);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand">
          <Server size={18} />
          <span>TensorMesh</span>
        </div>
        <div>
          <h1>{error ? "无法进入上传会话" : "正在验证上传 token"}</h1>
          <p>{error ?? "正在查找与该 token 对应的临时上传目录…"}</p>
        </div>
        {error ? <Button onClick={() => { window.location.href = "/upload"; }}>重新输入 token</Button> : null}
      </section>
    </main>
  );
}

function UploadPage({ sessionId }: { sessionId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<UploadSessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/upload-api/${encodeURIComponent(sessionId)}`)
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(payload?.message ?? `API returned ${response.status}`);
        }
        return response.json() as Promise<UploadSessionInfo>;
      })
      .then((nextSession) => {
        if (!cancelled) setSession(nextSession);
      })
      .catch((error) => {
        if (!cancelled) setSessionError(error instanceof Error ? error.message : "访问 token 无效或上传会话已过期。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function addFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    const timestamp = Date.now();
    setItems((current) => [
      ...current,
      ...selected.map((file, index) => ({
        id: `${timestamp}-${index}-${file.name}-${file.lastModified}`,
        file,
        state: "queued" as const,
        progress: 0
      }))
    ]);
  }

  function updateItem(id: string, update: Partial<UploadQueueItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  }

  async function uploadQueued() {
    const pending = items.filter((item) => item.state === "queued" || item.state === "error");
    if (pending.length === 0 || busy || !session) return;
    setBusy(true);
    for (const item of pending) {
      updateItem(item.id, { state: "uploading", progress: 0, message: undefined });
      try {
        const result = await uploadFile(sessionId, item.file, (progress) => updateItem(item.id, { progress }));
        updateItem(item.id, {
          state: "complete",
          progress: 100,
          savedName: result.name,
          message: result.name === item.file.name ? "上传完成" : `已保存为 ${result.name}`
        });
      } catch (error) {
        updateItem(item.id, {
          state: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    setBusy(false);
  }

  const queuedCount = items.filter((item) => item.state === "queued" || item.state === "error").length;
  const completeCount = items.filter((item) => item.state === "complete").length;
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  return (
    <main className="upload-shell">
      <nav className="upload-topbar">
        <div className="brand">
          <Server size={20} />
          <span>TensorMesh</span>
          <span className="upload-brand-divider" />
          <span className="upload-brand-label">Transfer</span>
        </div>
        <div className="topbar-actions">
          <Badge tone={session ? "idle" : "warning"}>
            <ShieldCheck size={13} />
            {session?.user ?? "验证 token"}
          </Badge>
          <Button variant="secondary" onClick={() => { window.location.href = `/upload/${sessionId}`; }}>
            <LogOut size={15} />
            更换 token
          </Button>
        </div>
      </nav>

      <div className="upload-layout">
        <header className="upload-hero">
          <div>
            <p className="eyebrow">安全文件传输</p>
            <h1>把文件送到服务器。</h1>
            <p>使用 TensorMesh 临时 token 验证身份，文件将以当前 Linux 用户身份流式写入指定目录。</p>
            <div className="upload-directory">
              <FolderOpen size={15} />
              <code>{session?.directory ?? "正在读取目标目录…"}</code>
            </div>
          </div>
          <div className="upload-session-card">
            <ShieldCheck size={19} />
            <div>
              <span>当前会话</span>
              <strong>{session?.user ?? "正在验证"}</strong>
              <small>{session?.expiresAt ? `${new Date(session.expiresAt).toLocaleString()} 过期` : "签名 token"}</small>
            </div>
          </div>
        </header>

        {sessionError ? (
          <section className="upload-auth-error">
            <XCircle size={22} />
            <div>
              <h2>无法验证访问权限</h2>
              <p>{sessionError}</p>
            </div>
            <Button onClick={() => { window.location.href = `/upload/${sessionId}`; }}>输入新 token</Button>
          </section>
        ) : (
          <>
            <section
              className={`upload-dropzone${dragActive ? " is-dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                addFiles(event.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                className="sr-only"
                type="file"
                multiple
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <div className="upload-drop-icon"><UploadCloud size={30} /></div>
              <div>
                <h2>{dragActive ? "松开即可添加" : "拖放文件到这里"}</h2>
                <p>也可以点击选择多个文件；同名文件会自动保留为新副本。</p>
              </div>
              <Button type="button" variant="secondary" onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}>
                <FolderOpen size={16} />
                选择文件
              </Button>
            </section>

            <section className="upload-queue-panel">
              <div className="upload-queue-header">
                <div>
                  <p className="eyebrow">上传队列</p>
                  <h2>{items.length === 0 ? "还没有选择文件" : `${items.length} 个文件 · ${formatFileSize(totalBytes)}`}</h2>
                </div>
                <div className="upload-queue-actions">
                  {completeCount > 0 ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setItems((current) => current.filter((item) => item.state !== "complete"))}>
                      清除已完成
                    </Button>
                  ) : null}
                  <Button disabled={!session || busy || queuedCount === 0} onClick={() => void uploadQueued()}>
                    <UploadCloud size={16} />
                    {busy ? "正在上传" : `开始上传${queuedCount ? ` (${queuedCount})` : ""}`}
                  </Button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="upload-empty-state">
                  <Files size={28} />
                  <p>选择文件后，可以在这里查看大小、进度和保存结果。</p>
                </div>
              ) : (
                <div className="upload-file-list">
                  {items.map((item) => (
                    <article className="upload-file-row" key={item.id}>
                      <div className={`upload-file-status is-${item.state}`}>
                        {item.state === "complete" ? <CheckCircle2 size={18} /> : item.state === "error" ? <XCircle size={18} /> : <FileText size={18} />}
                      </div>
                      <div className="upload-file-main">
                        <div className="upload-file-title">
                          <strong>{item.file.name}</strong>
                          <span>{formatFileSize(item.file.size)}</span>
                        </div>
                        <div className="upload-file-progress"><span style={{ width: `${item.progress}%` }} /></div>
                        <small className={item.state === "error" ? "is-error" : ""}>
                          {item.message ?? (item.state === "uploading" ? `${item.progress}%` : "等待上传")}
                        </small>
                      </div>
                      {item.state !== "uploading" ? (
                        <button
                          className="upload-file-remove"
                          type="button"
                          aria-label={`移除 ${item.file.name}`}
                          onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}
                        >
                          <X size={16} />
                        </button>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export function App() {
  if (!webToken) return <TokenLogin />;
  if (window.location.pathname === "/upload") return <UploadResolver />;
  const uploadMatch = window.location.pathname.match(/^\/upload\/([a-f0-9]{24})$/);
  if (uploadMatch) return <UploadPage sessionId={uploadMatch[1]} />;
  return <Dashboard />;
}

function Dashboard() {

  const [status, setStatus] = useState<SystemStatus>(() => (webToken ? emptyStatus : getMockSystemStatus()));
  const [isUsingFallback, setIsUsingFallback] = useState(!webToken);
  const [lastRefreshError, setLastRefreshError] = useState<string | null>(null);
  const [highlightedGpu, setHighlightedGpu] = useState<number | null>(null);
  const [visibleGpuIndexes, setVisibleGpuIndexes] = useState<number[] | null>(null);
  const [historyRange, setHistoryRange] = useState<HistoryRangeId>("2h");
  const [historyCustomFrom, setHistoryCustomFrom] = useState(() => toDatetimeLocal(new Date(Date.now() - 2 * 60 * 60 * 1000)));
  const [historyCustomTo, setHistoryCustomTo] = useState(() => toDatetimeLocal(new Date()));
  const [historyBrushSelection, setHistoryBrushSelection] = useState<HistoryBrushSelection | null>(null);
  const [historyByGpu, setHistoryByGpu] = useState<Record<number, GpuSample[]>>({});
  const [registerOpen, setRegisterOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionSettingsDraft, setSessionSettingsDraft] = useState<SessionInfo["settings"]>(defaultSessionSettings);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [testMailBusy, setTestMailBusy] = useState(false);
  const [autoSaveTimer, setAutoSaveTimer] = useState<number | null>(null);
  const [jobLog, setJobLog] = useState<JobLogPayload | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [registerForm, setRegisterForm] = useState({
    user: "alice",
    gpuIndexes: "0",
    project: "",
    content: "",
    command: "",
    expectedEndAt: "",
    taskNote: ""
  });
  const [reserveForm, setReserveForm] = useState({
    user: "alice",
    gpuIndexes: "0",
    project: "",
    content: "",
    command: "",
    workingDirectory: "/data",
    requestedStartAt: toDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000)),
    expiresAt: toDatetimeLocal(new Date(Date.now() + 6 * 60 * 60 * 1000)),
    note: ""
  });
  const [usage, setUsage] = useState<UsageSummary>(() => getMockUsageSummary("alice", 14));
  const [availableUsers, setAvailableUsers] = useState<string[]>(["alice"]);
  const [selectedUsageUser, setSelectedUsageUser] = useState("alice");
  const activeGpuIndexes = useMemo(() => {
    const active = status.gpus
      .filter((gpu) => gpu.state === "running" || gpu.state === "reserved" || gpu.memoryUsedMb > 1024 || gpu.utilizationPercent > 0)
      .map((gpu) => gpu.index);

    return active.length > 0 ? active : status.gpus.map((gpu) => gpu.index).slice(0, 2);
  }, [status.gpus]);
  const effectiveVisibleGpuIndexes = visibleGpuIndexes ?? activeGpuIndexes;
  const historyQuery = useMemo(
    () => buildHistoryQuery(historyRange, historyCustomFrom, historyCustomTo),
    [historyCustomFrom, historyCustomTo, historyRange]
  );
  const historyBrushScopeKey = useMemo(
    () => `${historyRange}|${historyQuery.bucketSeconds}|${effectiveVisibleGpuIndexes.join(",")}`,
    [effectiveVisibleGpuIndexes, historyQuery.bucketSeconds, historyRange]
  );
  const historyLines = useMemo<GpuHistoryLine[]>(
    () =>
      status.gpus
        .filter((gpu) => effectiveVisibleGpuIndexes.includes(gpu.index))
        .map((gpu) => ({
          gpuIndex: gpu.index,
          samples: historyByGpu[gpu.index] ?? (isUsingFallback ? getMockGpuHistory(gpu.index, 14) : []),
          color: chartColors[gpu.index % chartColors.length],
          smoothingWindow: historyQuery.smoothingWindow
        })),
    [effectiveVisibleGpuIndexes, historyByGpu, historyQuery.smoothingWindow, isUsingFallback, status.gpus]
  );

  useEffect(() => {
    let cancelled = false;
    let refreshCount = 0;

    async function refreshData() {
      try {
        const nextStatus = await fetchStatus();
        if (!cancelled) {
          setStatus(nextStatus);
          setIsUsingFallback(false);
          setLastRefreshError(null);
          void fetchUsage(selectedUsageUser).then((nextUsage) => {
            if (!cancelled) setUsage(nextUsage);
          }).catch(() => undefined);
        }

        refreshCount += 1;

        if (refreshCount === 1 || refreshCount % 15 === 0) {
          void fetchUsers().then((users) => {
            if (cancelled) return;
            const nextUsers = users.length > 0 ? users : [selectedUsageUser];
            setAvailableUsers(nextUsers);
            if (!nextUsers.includes(selectedUsageUser)) {
              setSelectedUsageUser(nextUsers[0]);
            }
          }).catch(() => undefined);
        }

        if (refreshCount === 1 || refreshCount % 3 === 0) {
          const requestHistoryQuery = buildHistoryQuery(historyRange, historyCustomFrom, historyCustomTo);
          void Promise.allSettled(
            nextStatus.gpus.map(async (gpu) => [gpu.index, await fetchGpuHistory(gpu.index, requestHistoryQuery)] as const)
          ).then((results) => {
            if (cancelled) return;

            setHistoryByGpu((previousHistory) => {
              const nextHistory = { ...previousHistory };
              let hasUpdate = false;

              for (const result of results) {
                if (result.status === "fulfilled") {
                  const [gpuIndex, samples] = result.value;
                  nextHistory[gpuIndex] = samples;
                  hasUpdate = true;
                }
              }

              return hasUpdate ? nextHistory : previousHistory;
            });
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLastRefreshError(error instanceof Error ? error.message : String(error));
          if (webToken) {
            setIsUsingFallback(false);
          }
        }
      }
    }

    void refreshData();
    const interval = window.setInterval(() => {
      void refreshData();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [historyCustomFrom, historyCustomTo, historyRange, selectedUsageUser]);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((nextSession) => {
        if (cancelled) return;
        setSession(nextSession);
        setSessionSettingsDraft({ ...defaultSessionSettings, ...nextSession.settings });
        setSelectedUsageUser(nextSession.user);
        setAvailableUsers((users) => users.includes(nextSession.user) ? users : [nextSession.user, ...users]);
        setRegisterForm((form) => ({ ...form, user: nextSession.user }));
        setReserveForm((form) => ({ ...form, user: nextSession.user }));
      })
      .catch((error) => {
        if (!cancelled) setSessionError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
  }, [autoSaveTimer]);

  const runningCount = status.gpus.filter((gpu) => gpu.state === "running").length;
  const reservedCount = status.gpus.filter((gpu) => gpu.state === "reserved").length;
  const idleCount = status.gpus.filter((gpu) => gpu.state === "idle").length;

  function updateRegisterField(name: keyof typeof registerForm, value: string) {
    setRegisterForm((form) => ({ ...form, [name]: value }));
  }

  function updateReserveField(name: keyof typeof reserveForm, value: string) {
    setReserveForm((form) => ({ ...form, [name]: value }));
  }

  function openRegisterDialog(task?: Task) {
    if (task) {
      setRegisterForm((form) => ({
        ...form,
        user: task.user,
        gpuIndexes: task.gpuIndexes.join(","),
        project: task.project === "未登记" ? "" : task.project,
        content: task.content,
        command: task.command,
        expectedEndAt: task.expectedEndAt ?? "",
        taskNote: task.taskNote ?? ""
      }));
    }
    setFormError(null);
    setRegisterOpen(true);
  }

  function setGpuVisibility(gpuIndex: number, checked: boolean) {
    const current = visibleGpuIndexes ?? activeGpuIndexes;
    const next = checked
      ? Array.from(new Set([...current, gpuIndex])).sort((a, b) => a - b)
      : current.filter((index) => index !== gpuIndex);
    setVisibleGpuIndexes(next);
    setHistoryBrushSelection(null);
    if (highlightedGpu === gpuIndex && !checked) {
      setHighlightedGpu(null);
    }
  }

  function showActiveGpus() {
    setVisibleGpuIndexes(null);
    setHistoryBrushSelection(null);
    if (highlightedGpu !== null && !activeGpuIndexes.includes(highlightedGpu)) {
      setHighlightedGpu(null);
    }
  }

  function updateHistoryRange(value: HistoryRangeId) {
    setHistoryRange(value);
    setHistoryBrushSelection(null);
    if (value === "custom") {
      const now = new Date();
      setHistoryCustomTo(toDatetimeLocal(now));
      setHistoryCustomFrom((current) => current || toDatetimeLocal(new Date(now.getTime() - 2 * 60 * 60 * 1000)));
    }
  }

  async function refreshStatusNow() {
    setStatus(await fetchStatus());
    setUsage(await fetchUsage(selectedUsageUser).catch(() => usage));
    setAvailableUsers(await fetchUsers().catch(() => availableUsers));
  }

  async function submitRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    try {
      await postJson<Task>("/api/tasks/register", {
        ...registerForm,
        gpuIndexes: registerForm.gpuIndexes
      });
      toast.success("任务登记已保存");
      setRegisterOpen(false);
      setRegisterForm((form) => ({ ...form, project: "", content: "", command: "", taskNote: "" }));
      await refreshStatusNow();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      toast.error("任务登记失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function submitReservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    try {
      await postJson<Reservation>("/api/reservations", {
        ...reserveForm,
        gpuIndexes: reserveForm.gpuIndexes
      });
      toast.success("预约已提交");
      setReserveOpen(false);
      setReserveForm((form) => ({ ...form, project: "", content: "", command: "", note: "" }));
      await refreshStatusNow();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      toast.error("预约提交失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function finishRegisteredTask(taskId: string) {
    try {
      await postJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/finish`, {});
      toast.success("登记任务已标记完成");
      await refreshStatusNow();
    } catch (error) {
      setLastRefreshError(error instanceof Error ? error.message : String(error));
      toast.error("标记完成失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function cancelOwnJob(jobId: string) {
    try {
      await postJson<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
      toast.success(`Job ${jobId} 已取消`);
      await refreshStatusNow();
    } catch (error) {
      setLastRefreshError(error instanceof Error ? error.message : String(error));
      toast.error("取消失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function openJobLog(jobId: string) {
    try {
      setJobLog(await fetchJobLog(jobId));
      setLogOpen(true);
    } catch (error) {
      setLastRefreshError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveReminderEmail() {
    setSessionError(null);
    try {
      const settings = await patchJson<SessionInfo["settings"]>("/api/session/settings", sessionSettingsClamp(sessionSettingsDraft));
      setSession((current) => current ? { ...current, settings } : current);
      setSessionSettingsDraft({ ...defaultSessionSettings, ...settings });
      toast.success("提醒设置已保存");
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      toast.error("保存失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  function autoSaveReminderSettings(nextSettings: SessionInfo["settings"]) {
    if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
    const next = sessionSettingsClamp(nextSettings);
    setSessionSettingsDraft(next);
    const timer = window.setTimeout(() => {
      void patchJson<SessionInfo["settings"]>("/api/session/settings", next)
        .then((settings) => {
          setSession((current) => current ? { ...current, settings } : current);
          setSessionSettingsDraft((draft) => ({ ...draft, ...settings }));
          setSessionError(null);
          toast.success("提醒设置已自动保存");
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setSessionError(message);
          toast.error("自动保存失败", { description: message });
        });
    }, 350);
    setAutoSaveTimer(timer);
  }

  async function sendTestMail() {
    setSessionError(null);
    setTestMailBusy(true);
    try {
      const settings = await patchJson<SessionInfo["settings"]>("/api/session/settings", sessionSettingsClamp(sessionSettingsDraft));
      setSession((current) => current ? { ...current, settings } : current);
      setSessionSettingsDraft({ ...defaultSessionSettings, ...settings });
      const result = await postJson<TestMailPayload>("/api/session/test-mail", { toMail: settings.reminderEmail });
      if (result.status === 200) {
        toast.success("测试邮件发送成功", { description: "Mail API 返回 200。" });
      } else {
        toast.info("测试邮件已提交", { description: `Mail API 状态 ${result.status}。` });
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
      toast.error("测试邮件发送失败", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestMailBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <nav className="topbar">
        <div className="brand">
          <Cpu size={22} />
          <span>TensorMesh</span>
        </div>
        <div className="topbar-actions">
          <Badge tone={isUsingFallback ? "warning" : "idle"}>
            {lastRefreshError ? "刷新异常" : isUsingFallback ? "Mock 数据" : "API 已连接"}
          </Badge>
          <Badge tone={session ? "idle" : "warning"}>
            <UserRound size={12} />
            {session?.user ?? "Token"}
          </Badge>
          <Button variant="secondary" onClick={() => void refreshStatusNow()}>
            <RefreshCw size={16} />
            刷新
          </Button>
          <Button asChild variant="secondary">
            <a href="/doc/" target="_blank" rel="noreferrer">
              <FileText size={16} />
              文档
            </a>
          </Button>
          <Button variant="secondary" onClick={() => downloadCsv("/api/export/current.html")}>
            <Download size={16} />
            Job 表格
          </Button>
          <Button variant="secondary" onClick={() => downloadCsv("/api/export/midnight.html")}>
            <Download size={16} />
            14天0点
          </Button>
        </div>
      </nav>

      <header className="dashboard-header">
        <div>
          <p className="eyebrow">GPU 使用管理台</p>
          <h1>{status.serverName}</h1>
          <p>查看当前任务、预约队列、GPU 利用率/显存曲线、用户卡时和 14 天历史数据。</p>
        </div>
        <div className="header-metrics">
          <MetricPill icon={<Server size={16} />} label="服务器" value={status.serverName} />
          <MetricPill icon={<Clock3 size={16} />} label="更新" value={new Date(status.updatedAt).toLocaleTimeString()} />
          <MetricPill icon={<UserRound size={16} />} label="当前用户" value={session?.user ?? selectedUsageUser} />
        </div>
      </header>

      <section className="summary-strip">
        <div>
          <span>运行中</span>
          <strong>{runningCount}</strong>
        </div>
        <div>
          <span>已预约</span>
          <strong>{reservedCount}</strong>
        </div>
        <div>
          <span>空闲</span>
          <strong>{idleCount}</strong>
        </div>
        <div>
          <span>活跃任务</span>
          <strong>{status.tasks.length}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>当前卡使用情况</h2>
            <p>每张卡显示使用人、任务、命令、显存和利用率。</p>
          </div>
        </div>
        <div className="gpu-table">
          {status.gpus.map((gpu) => (
            <button className="gpu-row-button" key={gpu.id} onClick={() => setHighlightedGpu(gpu.index)}>
              <GpuRow gpu={gpu} />
            </button>
          ))}
        </div>
      </section>

      <div className="two-column">
        <section className="panel history-panel">
          <div className="panel-header">
            <div>
              <h2>GPU 历史</h2>
              <p>后台保持 10 秒原始采样；页面按时间范围自动聚合和平滑，底部滑条可拖拽查看局部时段。</p>
            </div>
            <div className="history-actions">
              <Select value={historyRange} onValueChange={(value) => updateHistoryRange(value as HistoryRangeId)}>
                <SelectTrigger className="history-range-select" aria-label="GPU 历史时间范围">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {historyRangeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="secondary" onClick={showActiveGpus}>
                <RefreshCw size={16} />
                活跃卡
              </Button>
            </div>
          </div>
          {historyRange === "custom" && (
            <div className="history-custom-range">
              <label>
                <span>开始</span>
                <Input
                  type="datetime-local"
                  value={historyCustomFrom}
                  onChange={(event) => {
                    setHistoryCustomFrom(event.target.value);
                    setHistoryBrushSelection(null);
                  }}
                />
              </label>
              <label>
                <span>结束</span>
                <Input
                  type="datetime-local"
                  value={historyCustomTo}
                  onChange={(event) => {
                    setHistoryCustomTo(event.target.value);
                    setHistoryBrushSelection(null);
                  }}
                />
              </label>
            </div>
          )}
          <div className="history-meta">
            <span>展示粒度 {formatBucket(historyQuery.bucketSeconds)}</span>
            <span>平滑窗口 {historyQuery.smoothingWindow > 1 ? `${historyQuery.smoothingWindow} 点` : "关闭"}</span>
          </div>
          <div className="gpu-filter-list" aria-label="GPU 历史筛选">
            {status.gpus.map((gpu) => {
              const checked = effectiveVisibleGpuIndexes.includes(gpu.index);
              return (
                <label className="gpu-filter-item" key={gpu.id}>
                  <Checkbox checked={checked} onCheckedChange={(value) => setGpuVisibility(gpu.index, value === true)} />
                  <span>GPU {gpu.index}</span>
                  <Badge tone={stateTone(gpu.state)}>{stateLabel(gpu.state)}</Badge>
                </label>
              );
            })}
          </div>
          <GpuHistoryChart
            lines={historyLines}
            highlightedGpu={highlightedGpu}
            query={historyQuery}
            brushScopeKey={historyBrushScopeKey}
            brushSelection={historyBrushSelection}
            onBrushSelectionChange={setHistoryBrushSelection}
          />
        </section>

        <UsagePanel
          usage={usage}
          users={availableUsers}
          selectedUser={selectedUsageUser}
          onSelectedUserChange={setSelectedUsageUser}
          cpu={status.cpu}
        />
      </div>

      <ReservationQueue status={status} />

      <SessionPanel
        session={session}
        settingsDraft={sessionSettingsDraft}
        onSettingsChange={setSessionSettingsDraft}
        onAutoSave={autoSaveReminderSettings}
        onSave={() => void saveReminderEmail()}
        onTestMail={() => void sendTestMail()}
        testMailBusy={testMailBusy}
        error={sessionError}
      />

      <section className="panel task-panel">
        <div className="panel-header">
          <div>
            <h2>当前 Slurm 任务</h2>
            <p>Web 侧定位为查看门户；本人 token 可取消自己的 job 或查看日志尾部。</p>
          </div>
        </div>
        <div className="task-list">
          {status.slurm?.jobs.length === 0 || !status.slurm ? <p>当前没有 Slurm 任务。</p> : null}
          {status.slurm?.jobs.map((job) => (
            <article key={job.id} className="task-item">
              <div>
                <div className="task-title-row">
                  <Badge tone={job.state === "RUNNING" ? "running" : job.state === "PENDING" ? "warning" : "idle"}>
                    {job.state}
                  </Badge>
                  <h3>#{job.id} {job.name}</h3>
                </div>
                <p>{job.gres ?? "-"} · {job.elapsed} · {job.reason}</p>
                <div className={`task-kill-time${(killRemainingSeconds(job) ?? Number.POSITIVE_INFINITY) <= 86_400 ? " urgent" : ""}`}>
                  <Clock3 size={16} />
                  <span>强制终止倒计时</span>
                  <strong>{formatKillCountdown(job)}</strong>
                  <small>硬限制 {job.timeLimit} · {formatKillAt(job)}</small>
                </div>
                <code><Command size={14} /> {job.command ?? "-"}</code>
              </div>
              <div className="task-meta">
                <span>{job.user}</span>
                <span>{job.workDir ?? "-"}</span>
                <Button size="sm" variant="secondary" onClick={() => void openJobLog(job.id)} disabled={job.user !== session?.user}>
                  <Eye size={14} />
                  日志
                </Button>
                {job.user === session?.user && (job.state === "RUNNING" || job.state === "PENDING") ? (
                  <Button size="sm" variant="secondary" onClick={() => void cancelOwnJob(job.id)}>
                    <Square size={14} />
                    取消
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>登记用卡</DialogTitle>
            <DialogDescription>按“项目-内容”登记任务，GPU 可用逗号分隔。</DialogDescription>
          </DialogHeader>
          <form className="form-grid" onSubmit={submitRegister}>
            <label>
              使用人
              <Input value={registerForm.user} onChange={(event) => updateRegisterField("user", event.target.value)} />
            </label>
            <label>
              GPU
              <Input
                value={registerForm.gpuIndexes}
                onChange={(event) => updateRegisterField("gpuIndexes", event.target.value)}
                placeholder="0,1"
              />
            </label>
            <label>
              项目
              <Input
                value={registerForm.project}
                onChange={(event) => updateRegisterField("project", event.target.value)}
                placeholder="ProjectA"
              />
            </label>
            <label>
              内容
              <Input
                value={registerForm.content}
                onChange={(event) => updateRegisterField("content", event.target.value)}
                placeholder="baseline training"
              />
            </label>
            <label className="form-wide">
              命令
              <Textarea
                value={registerForm.command}
                onChange={(event) => updateRegisterField("command", event.target.value)}
                placeholder="CUDA_VISIBLE_DEVICES=0 python train.py"
              />
            </label>
            <label>
              预计结束
              <Input
                type="datetime-local"
                value={registerForm.expectedEndAt}
                onChange={(event) => updateRegisterField("expectedEndAt", event.target.value)}
              />
            </label>
            <label className="form-wide">
              说明
              <Textarea
                value={registerForm.taskNote}
                onChange={(event) => updateRegisterField("taskNote", event.target.value)}
                placeholder="任务简要说明"
              />
            </label>
            {formError ? <p className="form-error">{formError}</p> : null}
            <DialogFooter className="form-wide">
              <Button type="button" variant="secondary" onClick={() => setRegisterOpen(false)}>
                取消
              </Button>
              <Button type="submit">保存登记</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={reserveOpen} onOpenChange={setReserveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>预约用卡</DialogTitle>
            <DialogDescription>预约只做登记和协调，自动执行命令后续再打开。</DialogDescription>
          </DialogHeader>
          <form className="form-grid" onSubmit={submitReservation}>
            <label>
              预约人
              <Input value={reserveForm.user} onChange={(event) => updateReserveField("user", event.target.value)} />
            </label>
            <label>
              GPU
              <Input
                value={reserveForm.gpuIndexes}
                onChange={(event) => updateReserveField("gpuIndexes", event.target.value)}
                placeholder="2,3"
              />
            </label>
            <label>
              项目
              <Input value={reserveForm.project} onChange={(event) => updateReserveField("project", event.target.value)} />
            </label>
            <label>
              内容
              <Input value={reserveForm.content} onChange={(event) => updateReserveField("content", event.target.value)} />
            </label>
            <label>
              开始时间
              <Input
                type="datetime-local"
                value={reserveForm.requestedStartAt}
                onChange={(event) => updateReserveField("requestedStartAt", event.target.value)}
              />
            </label>
            <label>
              过期时间
              <Input
                type="datetime-local"
                value={reserveForm.expiresAt}
                onChange={(event) => updateReserveField("expiresAt", event.target.value)}
              />
            </label>
            <label className="form-wide">
              工作目录
              <Input
                value={reserveForm.workingDirectory}
                onChange={(event) => updateReserveField("workingDirectory", event.target.value)}
              />
            </label>
            <label className="form-wide">
              命令
              <Textarea value={reserveForm.command} onChange={(event) => updateReserveField("command", event.target.value)} />
            </label>
            <label className="form-wide">
              说明
              <Textarea value={reserveForm.note} onChange={(event) => updateReserveField("note", event.target.value)} />
            </label>
            {formError ? <p className="form-error">{formError}</p> : null}
            <DialogFooter className="form-wide">
              <Button type="button" variant="secondary" onClick={() => setReserveOpen(false)}>
                取消
              </Button>
              <Button type="submit">保存预约</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Job {jobLog?.jobId} 日志</DialogTitle>
            <DialogDescription>{jobLog?.path ?? "当前没有可读取的 TensorMesh 日志文件。"}</DialogDescription>
          </DialogHeader>
          <pre className="job-log-view">{jobLog?.content || "暂无日志内容。"}</pre>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setLogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export function SafeApp() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}
