import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { CpuStatus, GpuProcess, GpuStatus, SystemStatus, Task } from "@tensormesh/shared";
import { isSharedProcess } from "./shared-tasks";

const execFileAsync = promisify(execFile);
const defaultNvidiaSmiTimeoutMs = 15_000;

function getNvidiaSmiTimeoutMs(): number {
  const configured = Number(process.env.TENSORMESH_NVIDIA_SMI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.round(configured)
    : defaultNvidiaSmiTimeoutMs;
}

const nvidiaSmiTimeoutMs = getNvidiaSmiTimeoutMs();

interface RawGpu {
  index: number;
  uuid: string;
  name: string;
  memoryTotalMb: number;
  memoryUsedMb: number;
  utilizationPercent: number;
  temperatureC: number;
  powerW: number;
}

interface RawProcess {
  gpuUuid: string;
  pid: number;
  processName: string;
  memoryUsedMb: number;
}

interface PsInfo {
  username: string;
  startedAt: string;
  command: string;
}

interface CpuTickLine {
  id: string;
  idle: number;
  total: number;
}

let previousCpuTicks: Map<string, CpuTickLine> | null = null;

function parseNumber(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitCsvLine(line: string): string[] {
  return line.split(",").map((part) => part.trim());
}

async function runNvidiaSmi(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("nvidia-smi", args, {
    timeout: nvidiaSmiTimeoutMs,
    maxBuffer: 1024 * 1024
  });

  return stdout.trim();
}

async function queryGpus(): Promise<RawGpu[]> {
  const output = await runNvidiaSmi([
    "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw",
    "--format=csv,noheader,nounits"
  ]);

  if (!output) return [];

  return output
    .split("\n")
    .map((line) => splitCsvLine(line))
    .filter((columns) => columns.length >= 8)
    .map(([index, uuid, name, memoryTotal, memoryUsed, utilization, temperature, power]) => ({
      index: parseNumber(index),
      uuid,
      name,
      memoryTotalMb: parseNumber(memoryTotal),
      memoryUsedMb: parseNumber(memoryUsed),
      utilizationPercent: parseNumber(utilization),
      temperatureC: parseNumber(temperature),
      powerW: parseNumber(power)
    }));
}

async function queryGpuProcesses(): Promise<RawProcess[]> {
  let output = "";

  try {
    output = await runNvidiaSmi([
      "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
      "--format=csv,noheader,nounits"
    ]);
  } catch {
    return [];
  }

  if (!output) return [];

  return output
    .split("\n")
    .map((line) => splitCsvLine(line))
    .filter((columns) => columns.length >= 4)
    .map(([gpuUuid, pid, processName, memoryUsed]) => ({
      gpuUuid,
      pid: parseNumber(pid),
      processName,
      memoryUsedMb: parseNumber(memoryUsed)
    }))
    .filter((process) => process.pid > 0);
}

async function queryPsInfo(pids: number[]): Promise<Map<number, PsInfo>> {
  const result = new Map<number, PsInfo>();
  if (pids.length === 0) return result;

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,user=,lstart=,args=", "-p", pids.join(",")],
      {
        timeout: 3000,
        maxBuffer: 1024 * 1024
      }
    );

    for (const line of stdout.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;

      const pid = parseNumber(parts[0]);
      const username = parts[1];
      const startedAtRaw = parts.slice(2, 7).join(" ");
      const command = parts.slice(7).join(" ");
      const parsedStartedAt = new Date(startedAtRaw);

      result.set(pid, {
        username,
        startedAt: Number.isNaN(parsedStartedAt.getTime()) ? new Date().toISOString() : parsedStartedAt.toISOString(),
        command
      });
    }
  } catch {
    return result;
  }

  return result;
}

function buildInferredTask(gpuIndex: number, process: GpuProcess, processName: string): Task {
  return {
    id: `proc_${gpuIndex}_${process.pid}`,
    user: process.username,
    project: "未登记",
    content: processName,
    command: process.command,
    gpuIndexes: [gpuIndex],
    status: "running",
    startedAt: process.startedAt,
    taskNote: "由 nvidia-smi 自动识别，尚未绑定登记任务。"
  };
}

function parseCpuLine(line: string): CpuTickLine | null {
  const columns = line.trim().split(/\s+/);
  if (!columns[0]?.startsWith("cpu")) return null;

  const values = columns.slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;

  const idle = values[3] + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    id: columns[0],
    idle,
    total
  };
}

function calculateCpuUtilization(current: CpuTickLine, previous?: CpuTickLine): number {
  if (!previous) return 0;

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;

  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

export async function collectCpuStatus(): Promise<CpuStatus> {
  const [statContent, loadAverage] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    Promise.resolve(os.loadavg() as [number, number, number])
  ]);
  const cpuLines = statContent
    .split("\n")
    .map((line) => parseCpuLine(line))
    .filter((line): line is CpuTickLine => Boolean(line));
  const currentTicks = new Map(cpuLines.map((line) => [line.id, line]));
  const previousTicks = previousCpuTicks;
  previousCpuTicks = currentTicks;

  const totalLine = currentTicks.get("cpu");
  const cores = cpuLines
    .filter((line) => /^cpu\d+$/.test(line.id))
    .map((line) => ({
      index: Number(line.id.slice(3)),
      utilizationPercent: calculateCpuUtilization(line, previousTicks?.get(line.id))
    }));

  return {
    utilizationPercent: totalLine ? calculateCpuUtilization(totalLine, previousTicks?.get("cpu")) : 0,
    loadAverage: [
      Math.round(loadAverage[0] * 100) / 100,
      Math.round(loadAverage[1] * 100) / 100,
      Math.round(loadAverage[2] * 100) / 100
    ],
    coreCount: cores.length || os.cpus().length,
    cores
  };
}

export async function collectNvidiaStatus(): Promise<SystemStatus> {
  const gpus = await queryGpus();
  const rawProcesses = (await queryGpuProcesses()).filter(
    (process) => !isSharedProcess(process.pid)
  );
  const cpu = await collectCpuStatus();
  const psInfo = await queryPsInfo(rawProcesses.map((process) => process.pid));
  const tasks: Task[] = [];

  const gpusByUuid = new Map(gpus.map((gpu) => [gpu.uuid, gpu]));
  const processesByGpu = new Map<string, GpuProcess[]>();
  const processNames = new Map<number, string>();

  for (const rawProcess of rawProcesses) {
    const gpu = gpusByUuid.get(rawProcess.gpuUuid);
    if (!gpu) continue;

    const ps = psInfo.get(rawProcess.pid);
    const process: GpuProcess = {
      pid: rawProcess.pid,
      username: ps?.username ?? "unknown",
      command: ps?.command ?? rawProcess.processName,
      memoryUsedMb: rawProcess.memoryUsedMb,
      startedAt: ps?.startedAt ?? new Date().toISOString()
    };

    const existing = processesByGpu.get(gpu.uuid) ?? [];
    existing.push(process);
    processesByGpu.set(gpu.uuid, existing);
    processNames.set(rawProcess.pid, rawProcess.processName);
  }

  const gpuStatuses: GpuStatus[] = gpus.map((gpu) => {
    const processes = processesByGpu.get(gpu.uuid) ?? [];
    const currentTask = processes[0]
      ? buildInferredTask(gpu.index, processes[0], processNames.get(processes[0].pid) ?? "GPU process")
      : undefined;

    if (currentTask) {
      tasks.push(currentTask);
    }

    const isIdle = processes.length === 0 && gpu.memoryUsedMb <= 1024 && gpu.utilizationPercent <= 5;

    return {
      id: `gpu_${gpu.index}`,
      index: gpu.index,
      uuid: gpu.uuid,
      name: gpu.name,
      memoryTotalMb: gpu.memoryTotalMb,
      memoryUsedMb: gpu.memoryUsedMb,
      utilizationPercent: gpu.utilizationPercent,
      temperatureC: gpu.temperatureC,
      powerW: gpu.powerW,
      state: processes.length > 0 ? "running" : isIdle ? "idle" : "unknown",
      currentTask,
      processes
    };
  });

  return {
    serverName: process.env.TENSORMESH_SERVER_NAME ?? os.hostname(),
    updatedAt: new Date().toISOString(),
    cpu,
    gpus: gpuStatuses,
    tasks,
    reservations: []
  };
}
