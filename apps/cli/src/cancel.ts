import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import type { SlurmJob } from "@tensormesh/shared";

export interface CancelCommandDependencies {
  currentUser: string;
  getJobs: (user: string) => Promise<SlurmJob[]>;
  getJob: (jobId: string) => Promise<SlurmJob>;
  cancelJob: (jobId: string) => Promise<void>;
  selectJob: (jobs: SlurmJob[]) => Promise<SlurmJob | undefined>;
  confirmJob: (job: SlurmJob) => Promise<boolean>;
}

function singleLine(value: string | undefined): string {
  return (value?.trim() || "-").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
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

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += codePointWidth(char.codePointAt(0) ?? 0);
  return width;
}

function truncate(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const suffix = "...";
  const target = Math.max(0, width - suffix.length);
  let result = "";
  let used = 0;
  for (const char of value) {
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + charWidth > target) break;
    result += char;
    used += charWidth;
  }
  return `${result}${suffix}`;
}

function fit(value: string, width: number): string {
  const text = truncate(singleLine(value), width);
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

function gpuLabel(job: SlurmJob): string {
  if (job.allocatedGpuIndexes?.length) return job.allocatedGpuIndexes.map((index) => `GPU${index}`).join(",");
  return job.gres ?? job.tres ?? "-";
}

function reasonLabel(job: SlurmJob): string {
  return job.taskDescription ?? job.reason ?? "-";
}

export function formatCancelJobDetails(job: SlurmJob): string {
  const fields: Array<[string, string]> = [
    ["Job ID", job.id],
    ["Name", job.name],
    ["User", job.user],
    ["State", job.state],
    ["GPU", gpuLabel(job)],
    ["Time", `${job.elapsed} / ${job.timeLimit}`],
    ["Nodes", job.nodes],
    ["WorkDir", job.workDir ?? "-"],
    ["Command", job.command ?? "-"],
    ["Reason", reasonLabel(job)]
  ];
  const labelWidth = Math.max(...fields.map(([label]) => label.length));
  const body = fields.map(([label, value]) => `${label.padEnd(labelWidth)}  ${singleLine(value)}`);
  return [`即将取消 Slurm Job ${job.id}`, "-".repeat(48), ...body].join("\n");
}

export function nextCancelJobIndex(current: number, count: number, direction: "up" | "down"): number {
  if (count <= 0) return 0;
  return direction === "up" ? (current + count - 1) % count : (current + 1) % count;
}

function drawJobSelector(jobs: SlurmJob[], selected: number, output: WriteStream): void {
  const width = Math.max(60, Math.min(140, output.columns ?? 100));
  const pageSize = Math.max(1, Math.min(jobs.length, (output.rows ?? 24) - 7));
  const pageStart = Math.min(
    Math.max(0, selected - Math.floor(pageSize / 2)),
    Math.max(0, jobs.length - pageSize)
  );
  const page = jobs.slice(pageStart, pageStart + pageSize);
  const jobWidth = 10;
  const stateWidth = 12;
  const gpuWidth = 18;
  const elapsedWidth = 11;
  const nameWidth = Math.max(12, width - jobWidth - stateWidth - gpuWidth - elapsedWidth - 10);

  output.write("\x1b[H\x1b[2J");
  output.write("选择要取消的 Slurm job\n");
  output.write("Up/Down 移动  Enter 选择  Esc/q 退出\n\n");
  output.write(`  ${fit("JOB", jobWidth)} ${fit("STATE", stateWidth)} ${fit("GPU", gpuWidth)} ${fit("TIME", elapsedWidth)} ${fit("NAME", nameWidth)}\n`);

  page.forEach((job, offset) => {
    const index = pageStart + offset;
    const line = `${index === selected ? ">" : " "} ${fit(`#${job.id}`, jobWidth)} ${fit(job.state, stateWidth)} ${fit(gpuLabel(job), gpuWidth)} ${fit(job.elapsed, elapsedWidth)} ${fit(job.name, nameWidth)}`;
    output.write(index === selected ? `\x1b[7m${line}\x1b[0m\n` : `${line}\n`);
  });

  if (jobs.length > pageSize) output.write(`\n${selected + 1}/${jobs.length}\n`);
}

export function selectCancelJob(
  jobs: SlurmJob[],
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): Promise<SlurmJob | undefined> {
  if (jobs.length === 0) {
    output.write("当前用户没有可取消的 Slurm job。\n");
    return Promise.resolve(undefined);
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("tmesh cancel 需要交互终端；没有取消任何 job。");
  }

  let selected = 0;
  const wasRaw = input.isRaw === true;
  readline.emitKeypressEvents(input);
  input.resume();
  input.setRawMode(true);
  output.write("\x1b[?1049h");
  drawJobSelector(jobs, selected, output);

  return new Promise((resolve) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\x1b[?1049l");
    };
    const finish = (job: SlurmJob | undefined) => {
      cleanup();
      resolve(job);
    };
    const onKeypress = (_text: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        selected = nextCancelJobIndex(selected, jobs.length, "up");
      } else if (key.name === "down" || key.name === "j") {
        selected = nextCancelJobIndex(selected, jobs.length, "down");
      } else if (key.name === "return" || key.name === "enter") {
        finish(jobs[selected]);
        return;
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        finish(undefined);
        return;
      } else {
        return;
      }
      drawJobSelector(jobs, selected, output);
    };
    input.on("keypress", onKeypress);
  });
}

export function confirmCancelJob(
  job: SlurmJob,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): Promise<boolean> {
  output.write(`${formatCancelJobDetails(job)}\n\n`);
  if (!input.isTTY || !output.isTTY) {
    throw new Error("tmesh cancel 需要交互终端确认；没有取消任何 job。");
  }

  const interface_ = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    interface_.question(`是否确定取消 job ${job.id}？输入 Y 后回车 [y/N] `, (answer) => {
      interface_.close();
      resolve(isCancelConfirmation(answer));
    });
  });
}

export function isCancelConfirmation(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

export async function runCancelCommand(
  requestedJobId: string | undefined,
  dependencies: CancelCommandDependencies
): Promise<SlurmJob | undefined> {
  let jobId = requestedJobId?.trim();

  if (!jobId) {
    const jobs = await dependencies.getJobs(dependencies.currentUser);
    const selected = await dependencies.selectJob(jobs);
    if (!selected) return undefined;
    jobId = selected.id;
  }

  const job = await dependencies.getJob(jobId);
  if (job.user !== dependencies.currentUser) {
    throw new Error(`拒绝取消 job ${job.id}：owner 是 ${job.user}，当前用户是 ${dependencies.currentUser}。`);
  }

  if (!await dependencies.confirmJob(job)) return undefined;
  await dependencies.cancelJob(job.id);
  return job;
}
