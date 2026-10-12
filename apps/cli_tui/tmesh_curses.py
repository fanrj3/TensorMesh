#!/usr/bin/env python3
from __future__ import annotations

import curses
import csv
from datetime import datetime
import json
import getpass
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_CLI = REPO_ROOT / "apps" / "cli" / "src" / "index.ts"
TMESH_BIN = REPO_ROOT / "bin" / "tmesh"
API_BASE = os.environ.get("TENSORMESH_API", "http://localhost:4317").rstrip("/")
LAST_GPU_ERROR = ""

CP_NORMAL = 0
CP_SELECTED = 2
CP_GREEN = 3
CP_YELLOW = 4
CP_RED = 5
CP_GREEN_SEL = 6
CP_YELLOW_SEL = 7
CP_RED_SEL = 8
CP_TITLE = 9
CP_PROMPT = 10
CP_MUTED = 11
CP_CARD = 13
CP_CARD_SELECTED = 14
CP_TRAFFIC_RED = 15
CP_TRAFFIC_YELLOW = 16
CP_TRAFFIC_GREEN = 17

PALETTE_COMMANDS: list[tuple[str, str]] = [
  ("run", "提交 batch run 到选中的 GPU"),
  ("bash", "开启交互 bash"),
  ("reserve", "预约选中的 GPU"),
  ("cancel", "取消选中的 job"),
  ("refresh", "刷新状态"),
  ("detail", "查看当前选择详情"),
  ("jobs", "切换到 jobs 面板"),
  ("gpus", "切换到 GPU 面板"),
  ("quit", "退出面板"),
]


@dataclass
class GpuRow:
  index: str
  state: str
  memory: str
  util: str
  temp: str
  user: str
  task: str
  model: str
  uuid: str


@dataclass
class JobRow:
  job_id: str
  user: str
  state: str
  gpus: str
  elapsed: str
  name: str
  reason: str
  partition: str = "-"
  nodes: str = "-"
  limit: str = "-"
  kill_remaining: str = "-"
  kill_remaining_seconds: int | None = None
  estimate: str = "-"
  overdue: bool = False
  workdir: str = "-"
  command: str = "-"


@dataclass
class NodeRow:
  name: str
  state: str
  cpus: str
  mem: str
  gres: str


@dataclass
class Snapshot:
  nodes: list[NodeRow]
  jobs: list[JobRow]
  gpus: list[GpuRow]
  checked_at: float
  error: str = ""


def run_command(args: list[str], timeout: int = 10) -> tuple[int, str, str]:
  try:
    completed = subprocess.run(
      args,
      cwd=REPO_ROOT,
      text=True,
      capture_output=True,
      timeout=timeout,
      check=False,
    )
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()
  except FileNotFoundError:
    return 127, "", f"command not found: {args[0]}"
  except subprocess.TimeoutExpired as error:
    out = error.stdout if isinstance(error.stdout, str) else ""
    err = error.stderr if isinstance(error.stderr, str) else ""
    return 124, out.strip(), err.strip() or f"{args[0]} timed out"


def run_backend(args: list[str], timeout: int = 120) -> tuple[int, str]:
  if TMESH_BIN.exists():
    code, out, err = run_command([str(TMESH_BIN), *args], timeout=timeout)
  else:
    code, out, err = run_command(["node", "--import", "tsx", str(NODE_CLI), *args], timeout=timeout)
  text = "\n".join(part for part in [out, err] if part)
  return code, text


def safe_int(value: str) -> int:
  try:
    return int(float(value))
  except ValueError:
    return 0


def short_model(value: str) -> str:
  return " ".join(value.replace("NVIDIA", "").replace("GeForce", "").split())


def api_status() -> tuple[dict | None, str]:
  try:
    import urllib.request

    with urllib.request.urlopen(f"{API_BASE}/api/status", timeout=1.5) as response:
      return json.loads(response.read().decode("utf-8")), ""
  except Exception as error:
    return None, str(error)


def split_pipe(line: str) -> list[str]:
  return [part.strip() for part in line.split("|")]


def parse_scontrol(output: str) -> dict[str, str]:
  values: dict[str, str] = {}
  for item in output.replace("\n", " ").split():
    if "=" in item:
      key, value = item.split("=", 1)
      values[key] = value
  return values


def active_job_state(state: str) -> bool:
  return any(token in state.upper() for token in ["RUNNING", "PENDING", "CONFIGURING", "COMPLETING", "SUSPENDED"])


def parse_slurm_duration(value: str) -> int | None:
  if not value or value == "-" or value.upper() in ("UNLIMITED", "INFINITE", "N/A", "NOT_SET"):
    return None
  day_match = re.fullmatch(r"(\d+)-(\d+):(\d{2}):(\d{2})", value)
  if day_match:
    days, hours, minutes, seconds = (int(part) for part in day_match.groups())
    if hours > 23 or minutes > 59 or seconds > 59:
      return None
    return days * 86400 + hours * 3600 + minutes * 60 + seconds
  hour_match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})", value)
  if hour_match:
    hours, minutes, seconds = (int(part) for part in hour_match.groups())
    if minutes > 59 or seconds > 59:
      return None
    return hours * 3600 + minutes * 60 + seconds
  minute_match = re.fullmatch(r"(\d+):(\d{2})", value)
  if minute_match:
    minutes, seconds = (int(part) for part in minute_match.groups())
    return minutes * 60 + seconds if seconds <= 59 else None
  return None


def compact_slurm_duration(seconds: int) -> str:
  total = max(0, seconds)
  days, remainder = divmod(total, 86400)
  hours, remainder = divmod(remainder, 3600)
  minutes = remainder // 60
  if days:
    return f"{days}d{hours:02d}h{minutes:02d}m"
  if hours:
    return f"{hours}h{minutes:02d}m"
  return f"{minutes}m"


def kill_countdown(state: str, elapsed: str, limit: str) -> tuple[str, int | None]:
  limit_seconds = parse_slurm_duration(limit)
  if "PENDING" in state.upper() or "REQUEUED" in state.upper():
    return (f"start {compact_slurm_duration(limit_seconds)}", None) if limit_seconds is not None else ("-", None)
  if not any(token in state.upper() for token in ["RUNNING", "CONFIGURING", "COMPLETING", "SUSPENDED", "RESIZING"]):
    return "-", None
  elapsed_seconds = parse_slurm_duration(elapsed)
  if elapsed_seconds is None or limit_seconds is None:
    return "-", None
  remaining = max(0, limit_seconds - elapsed_seconds)
  return compact_slurm_duration(remaining), remaining


def format_estimated_hours(hours: object) -> str | None:
  if not isinstance(hours, (int, float)) or hours <= 0:
    return None
  if hours < 1 / 60:
    return f"{max(1, round(hours * 3600))}s"
  if hours < 1:
    return f"{round(hours * 60)}m"
  if float(hours).is_integer():
    return f"{int(hours)}h"
  return f"{hours:.2f}".rstrip("0").rstrip(".") + "h"


def parse_estimate(comment: str | None) -> tuple[str, bool]:
  if not comment or not comment.startswith("tmesh:"):
    return "-", False
  try:
    payload = json.loads(comment.removeprefix("tmesh:"))
    end_at = payload.get("estimatedEndAt")
    hours = payload.get("estimatedHours")
    if not end_at:
      return "-", False
    end_time = datetime.fromisoformat(str(end_at).replace("Z", "+00:00")).timestamp()
    label_time = time.strftime("%m-%d %H:%M", time.localtime(end_time))
    duration = format_estimated_hours(hours)
    label = f"{duration} {label_time}" if duration else label_time
    return label, time.time() > end_time
  except Exception:
    return "-", False


def parse_task_description(comment: str | None) -> str | None:
  if not comment or not comment.startswith("tmesh:"):
    return None
  try:
    import base64

    payload = json.loads(comment.removeprefix("tmesh:"))
    encoded = payload.get("descriptionB64")
    if isinstance(encoded, str) and encoded:
      padded = encoded + "=" * (-len(encoded) % 4)
      return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8").strip() or None
    description = payload.get("description")
    return str(description).strip() if description else None
  except Exception:
    return None


def load_nodes() -> list[NodeRow]:
  code, out, _err = run_command(["sinfo", "--noheader", "--Node", "--format=%N|%T|%c|%m|%G|%E"])
  if code != 0 or not out:
    return []
  rows = []
  for line in out.splitlines():
    parts = split_pipe(line)
    if len(parts) >= 5:
      rows.append(NodeRow(parts[0], parts[1], parts[2], parts[3], parts[4]))
  return rows


def load_job_detail(job_id: str) -> JobRow | None:
  code, out, _err = run_command(["scontrol", "show", "job", job_id, "--details"])
  if code != 0 or not out:
    return None
  values = parse_scontrol(out)
  state = values.get("JobState", "-")
  estimate, overdue = parse_estimate(values.get("Comment"))
  reason = parse_task_description(values.get("Comment")) or values.get("Reason", "-")
  elapsed = values.get("RunTime", "-")
  limit = values.get("TimeLimit", "-")
  remaining, remaining_seconds = kill_countdown(state, elapsed, limit)
  return JobRow(
    job_id=values.get("JobId", job_id),
    user=values.get("UserId", "-").split("(")[0],
    state=state,
    gpus=values.get("Gres") or values.get("GRES") or values.get("TresPerNode") or "-",
    elapsed=elapsed,
    name=values.get("JobName", "-"),
    reason=reason,
    partition=values.get("Partition", "-"),
    nodes=values.get("NodeList", "-"),
    limit=limit,
    kill_remaining=remaining,
    kill_remaining_seconds=remaining_seconds,
    estimate=estimate,
    overdue=overdue and active_job_state(state),
    workdir=values.get("WorkDir", "-"),
    command=values.get("Command", "-"),
  )


def load_jobs(all_jobs: bool = True) -> list[JobRow]:
  args = ["squeue", "--noheader", "--format=%i|%j|%u|%T|%P|%N|%M|%l|%R|%k|%b"]
  if not all_jobs:
    args.extend(["--user", getpass.getuser()])
  code, out, _err = run_command(args)
  if code != 0 or not out:
    return []
  jobs = []
  for line in out.splitlines():
    parts = split_pipe(line)
    if len(parts) < 9:
      continue
    detail = load_job_detail(parts[0])
    if detail:
      jobs.append(detail)
      continue
    comment = parts[9] if len(parts) > 9 else None
    estimate, overdue = parse_estimate(comment)
    reason = parse_task_description(comment) or parts[8]
    gres = parts[10] if len(parts) > 10 and parts[10] else "-"
    remaining, remaining_seconds = kill_countdown(parts[3], parts[6], parts[7])
    jobs.append(JobRow(
      job_id=parts[0], user=parts[2], state=parts[3], gpus=gres, elapsed=parts[6], name=parts[1],
      reason=reason, partition=parts[4], nodes=parts[5], limit=parts[7], kill_remaining=remaining,
      kill_remaining_seconds=remaining_seconds, estimate=estimate, overdue=overdue,
    ))
  return jobs


def load_gpu_processes() -> dict[str, list[dict[str, str]]]:
  code, out, _err = run_command([
    "nvidia-smi",
    "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
    "--format=csv,noheader,nounits",
  ])
  if code != 0 or not out:
    return {}
  rows = []
  for row in csv.reader(out.splitlines()):
    if len(row) >= 4:
      rows.append({
        "uuid": row[0].strip(),
        "pid": row[1].strip(),
        "process": Path(row[2].strip()).name,
        "memory": row[3].strip(),
      })
  pids = sorted({row["pid"] for row in rows})
  users = {}
  if pids:
    code, out, _err = run_command(["ps", "-o", "pid=,user=", "-p", ",".join(pids)])
    if code == 0:
      for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
          users[parts[0]] = parts[1]
  grouped: dict[str, list[dict[str, str]]] = {}
  for row in rows:
    row["user"] = users.get(row["pid"], "-")
    grouped.setdefault(row["uuid"], []).append(row)
  return grouped


def load_gpus() -> list[GpuRow]:
  global LAST_GPU_ERROR
  LAST_GPU_ERROR = ""

  status, api_error = api_status()
  collector_error = ""
  if isinstance(status, dict) and isinstance(status.get("gpus"), list):
    collector = status.get("collector")
    if isinstance(collector, dict) and collector.get("source") == "unavailable":
      collector_error = str(collector.get("reason") or "collector unavailable")
    rows = []
    for gpu in status["gpus"]:
      processes = gpu.get("processes") if isinstance(gpu.get("processes"), list) else []
      users = sorted({
        str(user)
        for user in [
          gpu.get("currentTask", {}).get("user") if isinstance(gpu.get("currentTask"), dict) else None,
          gpu.get("reservation", {}).get("user") if isinstance(gpu.get("reservation"), dict) else None,
          *[process.get("username") for process in processes if isinstance(process, dict)]
        ]
        if user
      })
      current_task = gpu.get("currentTask") if isinstance(gpu.get("currentTask"), dict) else None
      if current_task:
        project = str(current_task.get("project", "Task"))
        content = str(current_task.get("content", "-"))
        task = f"{project}: {content}"
      elif len(processes) == 1 and isinstance(processes[0], dict):
        command = str(processes[0].get("command", "process"))
        pid = safe_int(str(processes[0].get("pid", 0)))
        task = f"{command.split()[0]}:{pid}" if pid > 0 else command
      elif len(processes) > 1:
        task = f"{len(processes)} processes"
      else:
        task = "-"
      used = round(safe_int(str(gpu.get("memoryUsedMb", 0))) / 1024)
      total = round(safe_int(str(gpu.get("memoryTotalMb", 1))) / 1024)
      rows.append(GpuRow(
        index=str(gpu.get("index", "-")),
        state=str(gpu.get("state", "unknown")),
        memory=f"{used}/{total}G",
        util=f"{safe_int(str(gpu.get('utilizationPercent', 0)))}%",
        temp=f"{safe_int(str(gpu.get('temperatureC', 0)))}C",
        user=",".join(users) or "-",
        task=task,
        model=short_model(str(gpu.get("name", "-"))),
        uuid=str(gpu.get("uuid", "-")),
      ))
    if rows:
      return rows

  code, out, _err = run_command([
    "nvidia-smi",
    "--query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
    "--format=csv,noheader,nounits",
  ])
  if code != 0 or not out:
    parts = []
    if api_error:
      parts.append(f"API {API_BASE} unavailable: {api_error}")
    elif collector_error:
      parts.append(f"API collector unavailable: {collector_error}")
    parts.append("local nvidia-smi unavailable, likely due GPU isolation")
    parts.append("start TensorMesh API outside the login-shell GPU isolation")
    LAST_GPU_ERROR = "; ".join(parts)
    return []
  processes = load_gpu_processes()
  rows = []
  for row in csv.reader(out.splitlines()):
    if len(row) < 7:
      continue
    index, uuid, name, used, total, util, temp = [item.strip() for item in row[:7]]
    procs = processes.get(uuid, [])
    users = ",".join(sorted({proc["user"] for proc in procs if proc.get("user")})) or "-"
    if len(procs) == 1:
      task = f"{procs[0]['process']}:{procs[0]['pid']} {round(safe_int(procs[0]['memory']) / 1024, 1)}G"
    elif len(procs) > 1:
      task = f"{len(procs)} processes"
    else:
      task = "-"
    state = "running" if procs or safe_int(used) > 1024 or safe_int(util) > 0 else "idle"
    rows.append(GpuRow(
      index=index,
      state=state,
      memory=f"{round(safe_int(used) / 1024)}/{round(safe_int(total) / 1024)}G",
      util=f"{safe_int(util)}%",
      temp=f"{safe_int(temp)}C",
      user=users,
      task=task,
      model=short_model(name),
      uuid=uuid,
    ))
  return rows


def load_snapshot() -> Snapshot:
  try:
    gpus = load_gpus()
    return Snapshot(load_nodes(), load_jobs(True), gpus, time.time(), LAST_GPU_ERROR if not gpus else "")
  except Exception as error:  # keep TUI alive even if one command fails
    return Snapshot([], [], [], time.time(), str(error))


def init_colors() -> None:
  curses.start_color()
  curses.use_default_colors()
  curses.init_pair(CP_SELECTED, curses.COLOR_BLACK, curses.COLOR_WHITE)
  curses.init_pair(CP_GREEN, curses.COLOR_GREEN, -1)
  curses.init_pair(CP_YELLOW, curses.COLOR_YELLOW, -1)
  curses.init_pair(CP_RED, curses.COLOR_RED, -1)
  curses.init_pair(CP_GREEN_SEL, curses.COLOR_GREEN, curses.COLOR_WHITE)
  curses.init_pair(CP_YELLOW_SEL, curses.COLOR_YELLOW, curses.COLOR_WHITE)
  curses.init_pair(CP_RED_SEL, curses.COLOR_RED, curses.COLOR_WHITE)
  curses.init_pair(CP_TITLE, curses.COLOR_WHITE, curses.COLOR_BLACK)
  curses.init_pair(CP_PROMPT, curses.COLOR_BLACK, curses.COLOR_WHITE)
  curses.init_pair(CP_MUTED, -1, -1)
  curses.init_pair(CP_CARD, -1, -1)
  curses.init_pair(CP_CARD_SELECTED, curses.COLOR_BLACK, curses.COLOR_WHITE)
  curses.init_pair(CP_TRAFFIC_RED, curses.COLOR_RED, curses.COLOR_BLACK)
  curses.init_pair(CP_TRAFFIC_YELLOW, curses.COLOR_YELLOW, curses.COLOR_BLACK)
  curses.init_pair(CP_TRAFFIC_GREEN, curses.COLOR_GREEN, curses.COLOR_BLACK)


def addstr(win, y: int, x: int, text: str, attr: int = 0) -> None:
  max_y, max_x = win.getmaxyx()
  if y < 0 or y >= max_y or x >= max_x:
    return
  available = max_x - x
  if available <= 0:
    return
  try:
    win.addstr(y, x, text[:available], attr)
  except curses.error:
    pass


def state_attr(state: str, selected: bool = False) -> int:
  lowered = state.lower()
  if "running" in lowered or "completed" in lowered:
    return curses.color_pair(CP_GREEN_SEL if selected else CP_GREEN)
  if "idle" in lowered:
    return curses.color_pair(CP_SELECTED) if selected else curses.color_pair(CP_MUTED) | curses.A_DIM
  if "pending" in lowered or "mixed" in lowered or "begin" in lowered:
    return curses.color_pair(CP_YELLOW_SEL if selected else CP_YELLOW)
  if "fail" in lowered or "down" in lowered or "cancel" in lowered or "error" in lowered:
    return curses.color_pair(CP_RED_SEL if selected else CP_RED)
  return curses.color_pair(CP_SELECTED if selected else CP_NORMAL)


def fit(text: str, width: int) -> str:
  if width <= 0:
    return ""
  if len(text) > width:
    return text[:max(0, width - 1)] + "…"
  return text.ljust(width)


def bar_text(label: str, current: str, total: str, width: int) -> str:
  total_int = max(1, safe_int(total.rstrip("G")))
  current_int = max(0, safe_int(current.rstrip("G")))
  fill_width = max(3, width - len(label) - len(current) - len(total) - 7)
  filled = min(fill_width, round(fill_width * current_int / total_int))
  return f"{label} [{'█' * filled}{'░' * (fill_width - filled)}] {current}/{total}"


def parse_memory(memory: str) -> tuple[str, str]:
  if "/" not in memory:
    return memory, "1G"
  used, total = memory.split("/", 1)
  return used.strip(), total.strip()


def gpu_memory_percent(gpu: GpuRow) -> int:
  used, total = parse_memory(gpu.memory)
  total_int = max(1, safe_int(total.rstrip("G")))
  return round(safe_int(used.rstrip("G")) * 100 / total_int)


def truncate_middle(text: str, width: int) -> str:
  if width <= 0:
    return ""
  if len(text) <= width:
    return text.ljust(width)
  if width <= 3:
    return text[:width]
  left = max(1, (width - 1) // 2)
  right = max(1, width - left - 1)
  return f"{text[:left]}…{text[-right:]}"


def draw_bar(stdscr, y: int, text: str, attr: int) -> None:
  _max_y, max_x = stdscr.getmaxyx()
  addstr(stdscr, y, 0, text[:max_x].ljust(max_x), attr)


def draw_title_bar(stdscr, text: str) -> None:
  _max_y, max_x = stdscr.getmaxyx()
  if max_x >= 32:
    draw_bar(stdscr, 0, " " * max_x, curses.color_pair(CP_TITLE) | curses.A_BOLD)
    addstr(stdscr, 0, 1, "●", curses.color_pair(CP_TRAFFIC_RED) | curses.A_BOLD)
    addstr(stdscr, 0, 3, "●", curses.color_pair(CP_TRAFFIC_YELLOW) | curses.A_BOLD)
    addstr(stdscr, 0, 5, "●", curses.color_pair(CP_TRAFFIC_GREEN) | curses.A_BOLD)
    addstr(stdscr, 0, 8, text.strip()[:max(0, max_x - 9)], curses.color_pair(CP_TITLE) | curses.A_BOLD)
  else:
    draw_bar(stdscr, 0, text, curses.color_pair(CP_TITLE) | curses.A_BOLD)


def top_hint(width: int, focus: str, checked_at: float) -> str:
  stamp = time.strftime("%H:%M:%S", time.localtime(checked_at))
  user = getpass.getuser()
  if width >= 112:
    return f" TensorMesh  {user}  {stamp}  Tab:{focus}  Enter:detail  r:run  i:bash  b:reserve  x:cancel  R:refresh  q:quit "
  if width >= 88:
    return f" TensorMesh  {user}  {stamp}  {focus}  Tab  Enter  r:run  i:bash  b:reserve  R  q "
  return f" TensorMesh  {user}  {stamp}  {focus}  Tab  r:run  i:bash  b:book  R  q "


def footer_hint(width: int, focus: str, gpus: int, jobs: int) -> str:
  if width >= 112:
    return f" Focus={focus}  GPUs={gpus}  Jobs={jobs}  arrows move  Tab panel  Enter detail  r run  i bash  b reserve  x cancel  R refresh  q quit"
  if width >= 88:
    return f" Focus={focus}  GPUs={gpus}  Jobs={jobs}  arrows move  Tab panel  Enter  r run  i bash  b reserve  R  q"
  return f" Focus={focus}  GPU={gpus}  Jobs={jobs}  arrows  Tab  r run  i bash  b book  R  q"


def draw_box(stdscr, y: int, x: int, h: int, w: int, title: str = "", attr: int = 0) -> None:
  if h < 2 or w < 4:
    return
  addstr(stdscr, y, x, "╭" + "─" * (w - 2) + "╮", attr)
  for row in range(1, h - 1):
    addstr(stdscr, y + row, x, "│" + " " * (w - 2) + "│", attr)
  addstr(stdscr, y + h - 1, x, "╰" + "─" * (w - 2) + "╯", attr)
  if title:
    addstr(stdscr, y, x + 2, f" {title} "[:max(0, w - 4)], attr | curses.A_BOLD)


def draw_text_in_box(stdscr, y: int, x: int, w: int, lines: list[tuple[str, int] | str]) -> None:
  for offset, item in enumerate(lines):
    if isinstance(item, tuple):
      text, attr = item
    else:
      text, attr = item, curses.A_NORMAL
    addstr(stdscr, y + offset, x, fit(text, w), attr)


def hairline_attr() -> int:
  return curses.color_pair(CP_CARD) | curses.A_DIM


def focus_attr(active: bool = False) -> int:
  return curses.color_pair(CP_CARD) | (curses.A_BOLD if active else curses.A_DIM)


def summary_height(max_y: int, max_x: int) -> int:
  if max_y < 28 or max_x < 92:
    return 4
  if max_y < 18 or max_x < 80:
    return 2
  return 7


def gpu_grid_columns_for_space(grid_h: int, grid_w: int) -> int:
  inner_w = max(0, grid_w - 4)
  inner_h = max(0, grid_h - 2)
  compact = inner_h < 14
  medium = not compact and inner_h < 28
  columns = 4 if compact and inner_w >= 96 else (3 if compact and inner_w >= 84 else (2 if inner_w >= 48 else 1))
  if medium:
    columns = 2 if inner_w >= 58 else 1
  return max(1, columns)


def current_gpu_columns(max_y: int, max_x: int) -> int:
  body_top = summary_height(max_y, max_x)
  footer_h = 1
  queue_h = 7 if max_y >= 30 else (3 if max_y < 26 else 5)
  body_h = max(8, max_y - body_top - queue_h - footer_h - 1)
  if max_x >= 112:
    inspector_w = max(34, min(46, max_x // 3))
    grid_w = max_x - inspector_w - 1
    grid_h = body_h
  else:
    detail_h = 0 if max_y < 26 else min(7, max(5, body_h // 3))
    grid_w = max_x
    grid_h = body_h - detail_h - (1 if detail_h else 0)
  return gpu_grid_columns_for_space(grid_h, grid_w)


def summarize(snapshot: Snapshot) -> dict[str, int]:
  running = sum(1 for gpu in snapshot.gpus if gpu.state == "running")
  idle = sum(1 for gpu in snapshot.gpus if gpu.state == "idle")
  pending = sum(1 for job in snapshot.jobs if "PENDING" in job.state.upper())
  active_jobs = sum(1 for job in snapshot.jobs if "RUNNING" in job.state.upper())
  return {
    "total": len(snapshot.gpus),
    "running": running,
    "idle": idle,
    "jobs": active_jobs,
    "pending": pending,
  }


def primary_node(snapshot: Snapshot) -> NodeRow | None:
  return snapshot.nodes[0] if snapshot.nodes else None


def node_caption(snapshot: Snapshot) -> str:
  node = primary_node(snapshot)
  if not node:
    return "local"
  return f"{node.name} {node.state}"


def selected_gpu(snapshot: Snapshot, cursor: int) -> GpuRow | None:
  if not snapshot.gpus:
    return None
  return snapshot.gpus[max(0, min(cursor, len(snapshot.gpus) - 1))]


def selected_job(snapshot: Snapshot, cursor: int) -> JobRow | None:
  if not snapshot.jobs:
    return None
  return snapshot.jobs[max(0, min(cursor, len(snapshot.jobs) - 1))]


def draw_top_summary(stdscr, snapshot: Snapshot, focus: str) -> int:
  max_y, max_x = stdscr.getmaxyx()
  summary = summarize(snapshot)
  node = node_caption(snapshot)
  draw_title_bar(stdscr, top_hint(max_x, focus, snapshot.checked_at))
  if max_y < 28 or max_x < 92:
    line = (
      f" Node {node}  "
      f"GPU {summary['running']}/{summary['total']} active  "
      f"Idle {summary['idle']}  "
      f"Queue {summary['jobs']} run / {summary['pending']} wait"
    )
    addstr(stdscr, 2, 0, fit(line, max_x), curses.A_BOLD)
    return 4
  if max_y < 18 or max_x < 80:
    return 2
  labels = [
    ("Server", node, curses.color_pair(CP_CARD) | curses.A_BOLD),
    ("GPU Pool", f"{summary['running']}/{summary['total']} active", curses.color_pair(CP_GREEN) | curses.A_BOLD),
    ("Idle", str(summary["idle"]), curses.color_pair(CP_MUTED) | curses.A_DIM),
    ("Queue", f"{summary['jobs']} run / {summary['pending']} wait", curses.color_pair(CP_YELLOW) | curses.A_BOLD),
  ]
  y = 2
  draw_box(stdscr, y, 0, 4, max_x, "TensorMesh Panel", hairline_attr())
  col_w = max(12, (max_x - 2) // len(labels))
  for idx, (label, value, attr) in enumerate(labels):
    x = 2 + idx * col_w
    w = col_w - 2 if idx < len(labels) - 1 else max_x - x - 2
    if idx > 0:
      sep_x = x - 1
      addstr(stdscr, y, sep_x, "┬", hairline_attr())
      addstr(stdscr, y + 1, sep_x, "│", hairline_attr())
      addstr(stdscr, y + 2, sep_x, "│", hairline_attr())
      addstr(stdscr, y + 3, sep_x, "┴", hairline_attr())
    addstr(stdscr, y + 1, x, fit(label, w), curses.color_pair(CP_MUTED) | curses.A_DIM)
    addstr(stdscr, y + 2, x, fit(value, w), attr)
  return y + 5


def draw_gpu_card(stdscr, y: int, x: int, h: int, w: int, gpu: GpuRow, selected: bool) -> None:
  border = curses.color_pair(CP_CARD_SELECTED if selected else CP_CARD) | (curses.A_BOLD if selected else curses.A_DIM)
  body = curses.color_pair(CP_SELECTED if selected else CP_CARD)
  draw_box(stdscr, y, x, h, w, f"GPU {gpu.index}", border)
  if h < 5 or w < 20:
    if h >= 3 and w >= 16:
      compact_line = f"{gpu.state.upper()} {gpu.memory} {gpu.util}"
      addstr(stdscr, y + 1, x + 2, fit(compact_line, w - 4), state_attr(gpu.state, selected))
    return
  state = gpu.state.upper()
  addstr(stdscr, y + 1, x + 2, fit(state, w - 4), state_attr(gpu.state, selected))
  addstr(stdscr, y + 2, x + 2, fit(f"{gpu.memory}  {gpu.util}  {gpu.temp}", w - 4), body)
  if h == 5:
    owner = gpu.user if gpu.user != "-" else "available"
    addstr(stdscr, y + 3, x + 2, fit(f"{owner}  {gpu.task}", w - 4), body)
    return
  used, total = parse_memory(gpu.memory)
  addstr(stdscr, y + 3, x + 2, fit(bar_text("mem", used, total, w - 4), w - 4), body)
  if h > 5:
    addstr(stdscr, y + 4, x + 2, fit(gpu.user if gpu.user != "-" else "available", w - 4), body)
  if h > 6:
    addstr(stdscr, y + 5, x + 2, fit(gpu.task, w - 4), body)


def draw_gpu_grid(stdscr, y: int, x: int, h: int, w: int, gpus: list[GpuRow], cursor: int, active: bool) -> None:
  title = "GPU Pool [active]" if active else "GPU Pool"
  draw_box(stdscr, y, x, h, w, title, focus_attr(active))
  if h < 8 or w < 24:
    return
  inner_x = x + 2
  inner_y = y + 1
  inner_w = w - 4
  inner_h = h - 2
  if not gpus:
    addstr(stdscr, inner_y, inner_x, fit("No GPU telemetry available.", inner_w), curses.color_pair(CP_YELLOW) | curses.A_BOLD)
    if LAST_GPU_ERROR and inner_h > 2:
      addstr(stdscr, inner_y + 2, inner_x, fit(LAST_GPU_ERROR, inner_w), curses.color_pair(CP_MUTED))
    if inner_h > 4:
      addstr(stdscr, inner_y + 4, inner_x, fit("Run TensorMesh API outside the isolated user, then refresh with R.", inner_w), curses.color_pair(CP_MUTED))
    return
  compact = inner_h < 14
  medium = not compact and inner_h < 28
  columns = gpu_grid_columns_for_space(h, w)
  card_gap = 1
  card_w = max(20, (inner_w - card_gap * (columns - 1)) // columns)
  card_h = 3 if compact else (5 if medium else 7)
  visible_rows = max(1, inner_h // card_h)
  visible_count = visible_rows * columns
  top = max(0, min(cursor - visible_count + 1, max(0, len(gpus) - visible_count)))
  for offset, gpu in enumerate(gpus[top:top + visible_count]):
    row = offset // columns
    col = offset % columns
    card_y = inner_y + row * card_h
    card_x = inner_x + col * (card_w + card_gap)
    draw_gpu_card(stdscr, card_y, card_x, min(card_h, y + h - card_y - 1), card_w, gpu, active and top + offset == cursor)


def draw_detail_panel(stdscr, y: int, x: int, h: int, w: int, snapshot: Snapshot, focus: str, job_cursor: int, gpu_cursor: int) -> None:
  draw_box(stdscr, y, x, h, w, "Inspector", hairline_attr())
  if h < 5 or w < 24:
    return
  lines: list[tuple[str, int] | str]
  if focus == "jobs" and snapshot.jobs:
    job = selected_job(snapshot, job_cursor)
    assert job is not None
    lines = [
      (f"Job {job.job_id}", curses.A_BOLD),
      f"Name    {job.name}",
      f"State   {job.state}",
      f"GPU     {job.gpus}",
      f"Time    {job.elapsed}/{job.limit}",
      f"Kill in {job.kill_remaining}",
      f"Expect  {job.estimate}",
      f"Node    {job.nodes}",
      f"Reason  {job.reason}",
      "",
      "Enter details   x cancel",
    ]
  elif focus == "gpus" and snapshot.gpus:
    gpu = selected_gpu(snapshot, gpu_cursor)
    assert gpu is not None
    lines = [
      (f"GPU {gpu.index}  {gpu.model}", curses.A_BOLD),
      f"Node    {node_caption(snapshot)}",
      f"State   {gpu.state}",
      f"Memory  {gpu.memory} ({gpu_memory_percent(gpu)}%)",
      f"Util    {gpu.util}",
      f"Temp    {gpu.temp}",
      f"User    {gpu.user}",
      f"Task    {gpu.task}",
      "",
      "r run   b reserve   Enter details",
      truncate_middle(gpu.uuid, w - 4),
    ]
  else:
    lines = ["No selection.", "", "Use Tab to switch panels."]
  draw_text_in_box(stdscr, y + 1, x + 2, w - 4, lines[:max(0, h - 2)])


def draw_job_queue_panel(stdscr, y: int, x: int, h: int, w: int, jobs: list[JobRow], cursor: int, active: bool) -> int:
  title = "Queue [active]" if active else "Queue"
  draw_box(stdscr, y, x, h, w, title, focus_attr(active))
  if h < 3:
    return cursor
  if not jobs:
    addstr(stdscr, y + 1, x + 2, fit("Queue clear. Press r to run on the selected GPU, or b to reserve.", w - 4), curses.color_pair(CP_MUTED) | curses.A_DIM)
    return 0
  if h < 4:
    addstr(stdscr, y + 1, x + 2, f"{len(jobs)} job(s) queued", curses.color_pair(CP_YELLOW))
    return cursor
  cursor = max(0, min(cursor, len(jobs) - 1))
  visible = max(1, h - 3)
  top = max(0, min(cursor - visible + 1, max(0, len(jobs) - visible)))
  header = "Job".rjust(6) + " " + "State".ljust(9) + " " + "GPU".ljust(12) + " " + "Kill in".ljust(16) + " " + "Name"
  addstr(stdscr, y + 1, x + 2, fit(header, w - 4), curses.A_BOLD)
  for row_i, job in enumerate(jobs[top:top + visible]):
    idx = top + row_i
    selected = active and idx == cursor
    attr = curses.color_pair(CP_SELECTED) if selected else curses.A_NORMAL
    line = job.job_id.rjust(6) + " " + fit(job.state, 9) + " " + fit(job.gpus, 12) + " " + fit(job.kill_remaining, 16) + " " + job.name
    addstr(stdscr, y + 2 + row_i, x + 2, fit(line, w - 4), attr)
    addstr(stdscr, y + 2 + row_i, x + 9, fit(job.state, 9), state_attr(job.state, selected))
    urgent = job.kill_remaining_seconds is not None and job.kill_remaining_seconds <= 86400
    addstr(stdscr, y + 2 + row_i, x + 31, fit(job.kill_remaining, 16), curses.color_pair(CP_RED if urgent else CP_YELLOW))
  return cursor


def prompt(stdscr, label: str, default: str = "") -> str | None:
  max_y, max_x = stdscr.getmaxyx()
  y = max_y - 2
  attr = curses.color_pair(CP_PROMPT) | curses.A_BOLD
  draw_bar(stdscr, y, f" {label}: ", attr)
  if default:
    addstr(stdscr, y, len(label) + 4, default, curses.color_pair(CP_PROMPT))
  curses.echo()
  curses.curs_set(1)
  try:
    value = stdscr.getstr(y, len(label) + 4, max(1, max_x - len(label) - 5)).decode().strip()
    return value or default
  except (KeyboardInterrupt, curses.error):
    return None
  finally:
    curses.noecho()
    curses.curs_set(0)


def prompt_checked(stdscr, label: str, default: str, validate) -> str | None:
  while True:
    value = prompt(stdscr, label, default)
    if value is None:
      return None
    if value.strip().lower() == "exit":
      return None
    error = validate(value)
    if not error:
      return value.strip()
    message(stdscr, error)


def validate_gpu_indexes(value: str) -> str | None:
  normalized = value.strip()
  if not normalized:
    return None
  if not re.fullmatch(r"\d+(?:\s*,\s*\d+)*", normalized):
    return "GPU indexes must look like 0 or 0,1,2."
  return None


def validate_gpu_count(value: str) -> str | None:
  try:
    count = int(value.strip())
  except ValueError:
    return "GPU count must be a positive integer."
  return None if count > 0 else "GPU count must be a positive integer."


def validate_hours(value: str) -> str | None:
  try:
    hours = float(value.strip())
  except ValueError:
    return "Estimated hours must be a positive number, for example 0.5 or 10."
  return None if hours > 0 else "Estimated hours must be a positive number."


def validate_required_text(field: str):
  def _validate(value: str) -> str | None:
    return None if value.strip() else f"{field} is required."

  return _validate


def validate_start_time(value: str) -> str | None:
  text = value.strip()
  if re.fullmatch(r"\d{2}:\d{2}", text):
    return None
  if re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", text):
    return None
  return "Start time must be HH:mm or YYYY-MM-DDTHH:mm."


def message(stdscr, text: str) -> None:
  max_y, _max_x = stdscr.getmaxyx()
  draw_bar(stdscr, max_y - 2, f" {text}", curses.color_pair(CP_PROMPT) | curses.A_BOLD)
  draw_bar(stdscr, max_y - 1, " Press any key", curses.color_pair(CP_TITLE))
  stdscr.getch()


def palette_candidates(query: str) -> list[tuple[str, str]]:
  normalized = query.strip().lstrip("/").lower()
  if not normalized:
    return PALETTE_COMMANDS
  starts = [(name, desc) for name, desc in PALETTE_COMMANDS if name.startswith(normalized)]
  if starts:
    return starts
  return [(name, desc) for name, desc in PALETTE_COMMANDS if normalized in name or normalized in desc.lower()]


def command_palette(stdscr) -> str | None:
  query = ""
  selected = 0
  curses.curs_set(1)

  def draw_palette() -> None:
    nonlocal selected
    max_y, max_x = stdscr.getmaxyx()
    candidates = palette_candidates(query)
    if candidates:
      selected = max(0, min(selected, len(candidates) - 1))
    else:
      selected = 0
    parts = []
    for index, (name, desc) in enumerate(candidates[:5]):
      marker = ">" if index == selected else " "
      parts.append(f"{marker} {name} - {desc}")
    hint = "   ".join(parts) if parts else "No matching command"
    draw_bar(stdscr, max_y - 2, f" {hint}", curses.color_pair(CP_MUTED))
    draw_bar(stdscr, max_y - 1, f" Command Mode  >> /{query}", curses.color_pair(CP_PROMPT) | curses.A_BOLD)
    stdscr.move(max_y - 1, min(max_x - 1, len(" Command Mode  >> /") + len(query)))
    stdscr.refresh()

  try:
    draw_palette()
    while True:
      ch = stdscr.getch()
      if ch in (27,):
        return None
      if ch in (curses.KEY_ENTER, 10, 13):
        candidates = palette_candidates(query)
        return candidates[selected][0] if candidates and not query.strip() else query.strip()
      if ch in (curses.KEY_UP,):
        selected = max(0, selected - 1)
        draw_palette()
        continue
      if ch in (curses.KEY_DOWN,):
        selected = min(max(0, len(palette_candidates(query)) - 1), selected + 1)
        draw_palette()
        continue
      if ch in (9,):
        candidates = palette_candidates(query)
        if candidates:
          query = candidates[selected][0]
          draw_palette()
        continue
      if ch in (curses.KEY_BACKSPACE, 127, 8):
        query = query[:-1]
        draw_palette()
        continue
      if 32 <= ch <= 126:
        char = chr(ch)
        if char == "/" and not query:
          draw_palette()
          continue
        query += char
        draw_palette()
  finally:
    curses.curs_set(0)


def detail_lines_for_gpu(gpu: GpuRow) -> list[str]:
  return [
    f"GPU      {gpu.index}",
    f"State    {gpu.state}",
    f"Memory   {gpu.memory}",
    f"Util     {gpu.util}",
    f"Temp     {gpu.temp}",
    f"User     {gpu.user}",
    f"Task     {gpu.task}",
    f"Model    {gpu.model}",
    f"UUID     {gpu.uuid}",
  ]


def detail_lines_for_job(job: JobRow) -> list[str]:
  return [
    f"Job       {job.job_id}",
    f"Name      {job.name}",
    f"User      {job.user}",
    f"State     {job.state}",
    f"GPU       {job.gpus}",
    f"Time      {job.elapsed} / {job.limit}",
    f"Kill in   {job.kill_remaining}",
    f"Estimate  {job.estimate}",
    f"Nodes     {job.nodes}",
    f"WorkDir   {job.workdir}",
    f"Command   {job.command}",
    f"Reason    {job.reason}",
  ]


def show_detail(stdscr, title: str, lines: list[str]) -> None:
  scroll = 0
  while True:
    stdscr.erase()
    max_y, max_x = stdscr.getmaxyx()
    draw_title_bar(stdscr, f" {title}  q/Esc:back")
    height = max_y - 2
    for i, line in enumerate(lines[scroll:scroll + height]):
      addstr(stdscr, i + 1, 0, fit(line, max_x))
    stdscr.refresh()
    ch = stdscr.getch()
    if ch in (ord("q"), 27, curses.KEY_LEFT):
      return
    if ch in (curses.KEY_DOWN, ord("j")):
      scroll = min(max(0, len(lines) - height), scroll + 1)
    if ch in (curses.KEY_UP, ord("k")):
      scroll = max(0, scroll - 1)


def collect_gpu_args(stdscr, gpu_index: str | None) -> list[str] | None:
  fixed = prompt_checked(stdscr, "GPU indexes", gpu_index or "", validate_gpu_indexes)
  if fixed is None:
    return None
  if fixed:
    return ["--gpu-indexes", fixed]
  count = prompt_checked(stdscr, "GPU count", "1", validate_gpu_count)
  if not count:
    return None
  return ["--gpus", count]


def submit_run(stdscr, gpu_index: str | None = None, reserve: bool = False) -> str:
  args = ["reserve" if reserve else "run"]
  if reserve:
    at = prompt_checked(stdscr, "Start time YYYY-MM-DDTHH:mm or HH:mm", "", validate_start_time)
    if not at:
      return "Cancelled."
    args.extend(["--at", at])
  gpu_args = collect_gpu_args(stdscr, gpu_index)
  if gpu_args is None:
    return "Cancelled."
  args.extend(gpu_args)
  name = prompt_checked(stdscr, "Job name", "tmesh-tui", validate_required_text("Job name"))
  if not name:
    return "Cancelled."
  runtime = prompt_checked(stdscr, "Estimated hours", "0.5", validate_hours)
  if not runtime:
    return "Cancelled."
  reason = prompt_checked(stdscr, "请描述当前任务(示例:盲道-大规模推理)", "", validate_required_text("Task description"))
  if not reason:
    return "Cancelled."
  command = prompt_checked(stdscr, "Command", "nvidia-smi", validate_required_text("Command"))
  if not command:
    return "Cancelled."
  try:
    command_args = shlex.split(command)
  except ValueError as error:
    return f"Command parse error: {error}"
  args.extend(["--name", name, "--time", runtime, "--reason", reason, "--", *command_args])
  code, text = run_backend(args)
  return text or f"backend exited with code {code}"


def collect_bash_args(stdscr, gpu_index: str | None = None) -> list[str] | None:
  gpu_args = collect_gpu_args(stdscr, gpu_index)
  if gpu_args is None:
    return None
  name = prompt_checked(stdscr, "Bash name", "tmesh-bash", validate_required_text("Bash name"))
  if not name:
    return None
  runtime = prompt_checked(stdscr, "Estimated hours", "24", validate_hours)
  if not runtime:
    return None
  reason = prompt_checked(stdscr, "请描述当前任务(示例:调试-MNIST)", "", validate_required_text("Task description"))
  if not reason:
    return None
  return ["bash", *gpu_args, "--name", name, "--time", runtime, "--reason", reason]


def run_interactive_bash(stdscr, gpu_index: str | None = None) -> str:
  args = collect_bash_args(stdscr, gpu_index)
  if args is None:
    return "Cancelled."
  curses.def_prog_mode()
  curses.endwin()
  try:
    completed = subprocess.run([str(TMESH_BIN), *args], cwd=REPO_ROOT, check=False)
    print(f"\n[TensorMesh] bash exited with code {completed.returncode}. Press Enter to return to panel.", flush=True)
    try:
      input()
    except EOFError:
      pass
    return f"bash exited with code {completed.returncode}"
  except FileNotFoundError:
    print(f"\nTensorMesh command not found: {TMESH_BIN}", flush=True)
    try:
      input("Press Enter to return to panel.")
    except EOFError:
      pass
    return f"command not found: {TMESH_BIN}"
  finally:
    curses.reset_prog_mode()
    curses.curs_set(0)


def cancel_job(stdscr, job_id: str | None) -> str:
  target = prompt(stdscr, "Job id", job_id or "")
  if not target:
    return "Cancelled."
  command = [str(TMESH_BIN), "cancel", target] if TMESH_BIN.exists() else [
    "node", "--import", "tsx", str(NODE_CLI), "cancel", target,
  ]
  curses.def_prog_mode()
  curses.endwin()
  try:
    completed = subprocess.run(command, cwd=REPO_ROOT, check=False)
    if completed.returncode == 0:
      return f"Cancelled job {target}."
    if completed.returncode == 130:
      return "Cancellation aborted."
    return f"cancel backend exited with code {completed.returncode}"
  except FileNotFoundError:
    return f"command not found: {command[0]}"
  finally:
    curses.reset_prog_mode()
    curses.curs_set(0)


def draw(stdscr, snap: Snapshot, focus: str, job_cursor: int, gpu_cursor: int) -> tuple[int, int]:
  stdscr.erase()
  max_y, max_x = stdscr.getmaxyx()
  if max_y < 18 or max_x < 74:
    addstr(stdscr, 0, 0, "Terminal too small. Resize to at least 74x18.", curses.A_BOLD)
    stdscr.refresh()
    return job_cursor, gpu_cursor

  y = draw_top_summary(stdscr, snap, focus)
  body_top = y
  footer_h = 1
  queue_h = 7 if max_y >= 30 else (3 if max_y < 26 else 5)
  body_h = max(8, max_y - body_top - queue_h - footer_h - 1)
  queue_y = body_top + body_h + 1

  if max_x >= 112:
    inspector_w = max(34, min(46, max_x // 3))
    grid_w = max_x - inspector_w - 1
    draw_gpu_grid(stdscr, body_top, 0, body_h, grid_w, snap.gpus, gpu_cursor, focus == "gpus")
    draw_detail_panel(stdscr, body_top, grid_w + 1, body_h, inspector_w - 1, snap, focus, job_cursor, gpu_cursor)
    job_cursor = draw_job_queue_panel(stdscr, queue_y, 0, queue_h, max_x, snap.jobs, job_cursor, focus == "jobs")
  else:
    detail_h = 0 if max_y < 26 else min(7, max(5, body_h // 3))
    grid_h = body_h - detail_h - (1 if detail_h else 0)
    draw_gpu_grid(stdscr, body_top, 0, grid_h, max_x, snap.gpus, gpu_cursor, focus == "gpus")
    if detail_h:
      draw_detail_panel(stdscr, body_top + grid_h + 1, 0, detail_h, max_x, snap, focus, job_cursor, gpu_cursor)
    job_cursor = draw_job_queue_panel(stdscr, queue_y, 0, queue_h, max_x, snap.jobs, job_cursor, focus == "jobs")

  if snap.error:
    draw_bar(stdscr, max_y - 2, f" Error: {snap.error}", curses.color_pair(CP_RED))
  status = footer_hint(max_x, focus, len(snap.gpus), len(snap.jobs))
  draw_bar(stdscr, max_y - 1, status, curses.color_pair(CP_TITLE))
  stdscr.refresh()
  return job_cursor, gpu_cursor


def show_current_detail(stdscr, snap: Snapshot, focus: str, job_cursor: int, gpu_cursor: int) -> None:
  if focus == "jobs" and snap.jobs:
    show_detail(stdscr, f"Job {snap.jobs[job_cursor].job_id}", detail_lines_for_job(snap.jobs[job_cursor]))
  elif focus == "gpus" and snap.gpus:
    show_detail(stdscr, f"GPU {snap.gpus[gpu_cursor].index}", detail_lines_for_gpu(snap.gpus[gpu_cursor]))


def tui(stdscr) -> None:
  init_colors()
  curses.curs_set(0)
  stdscr.keypad(True)
  focus = "gpus"
  job_cursor = 0
  gpu_cursor = 0
  snap = load_snapshot()
  while True:
    job_cursor, gpu_cursor = draw(stdscr, snap, focus, job_cursor, gpu_cursor)
    try:
      ch = stdscr.getch()
    except KeyboardInterrupt:
      return
    if ch in (ord("q"), 27):
      return
    if ch == curses.KEY_RESIZE:
      continue
    if ch in (ord("R"),):
      snap = load_snapshot()
      continue
    if ch == ord("/"):
      command = command_palette(stdscr)
      if command is None:
        continue
      normalized = command.strip().lower()
      if normalized in ("q", "quit"):
        return
      if normalized in ("refresh", "reload"):
        snap = load_snapshot()
        continue
      if normalized in ("jobs", "job"):
        focus = "jobs"
        continue
      if normalized in ("gpus", "gpu"):
        focus = "gpus"
        continue
      if normalized in ("detail", "open"):
        show_current_detail(stdscr, snap, focus, job_cursor, gpu_cursor)
        continue
      if normalized in ("run", "r"):
        gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
        message(stdscr, submit_run(stdscr, gpu, reserve=False))
        snap = load_snapshot()
        continue
      if normalized in ("bash", "i", "interactive"):
        gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
        result = run_interactive_bash(stdscr, gpu)
        if result == "Cancelled.":
          message(stdscr, result)
        snap = load_snapshot()
        continue
      if normalized in ("reserve", "book", "b"):
        gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
        message(stdscr, submit_run(stdscr, gpu, reserve=True))
        snap = load_snapshot()
        continue
      if normalized in ("cancel", "x"):
        job = snap.jobs[job_cursor].job_id if snap.jobs else None
        message(stdscr, cancel_job(stdscr, job))
        snap = load_snapshot()
        continue
      message(stdscr, f"Unknown command: {command}")
      continue
    if ch in (9, curses.KEY_BTAB):
      focus = "jobs" if focus == "gpus" else "gpus"
      continue
    max_y, max_x = stdscr.getmaxyx()
    gpu_columns = current_gpu_columns(max_y, max_x)
    if ch in (curses.KEY_UP, ord("k")):
      if focus == "jobs":
        job_cursor = max(0, job_cursor - 1)
      else:
        gpu_cursor = max(0, gpu_cursor - gpu_columns)
    elif ch in (curses.KEY_DOWN, ord("j")):
      if focus == "jobs":
        job_cursor = min(max(0, len(snap.jobs) - 1), job_cursor + 1)
      else:
        gpu_cursor = min(max(0, len(snap.gpus) - 1), gpu_cursor + gpu_columns)
    elif focus == "gpus" and ch in (curses.KEY_LEFT, ord("h")):
      gpu_cursor = max(0, gpu_cursor - 1)
    elif focus == "gpus" and ch in (curses.KEY_RIGHT, ord("l")):
      gpu_cursor = min(max(0, len(snap.gpus) - 1), gpu_cursor + 1)
    elif ch in (curses.KEY_ENTER, 10, 13):
      show_current_detail(stdscr, snap, focus, job_cursor, gpu_cursor)
    elif ch == ord("r"):
      gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
      message(stdscr, submit_run(stdscr, gpu, reserve=False))
      snap = load_snapshot()
    elif ch == ord("i"):
      gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
      result = run_interactive_bash(stdscr, gpu)
      if result == "Cancelled.":
        message(stdscr, result)
      snap = load_snapshot()
    elif ch == ord("b"):
      gpu = snap.gpus[gpu_cursor].index if snap.gpus else None
      message(stdscr, submit_run(stdscr, gpu, reserve=True))
      snap = load_snapshot()
    elif ch == ord("x"):
      job = snap.jobs[job_cursor].job_id if snap.jobs else None
      message(stdscr, cancel_job(stdscr, job))
      snap = load_snapshot()


def main() -> int:
  signal.signal(signal.SIGINT, lambda _sig, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
  try:
    curses.wrapper(tui)
  except KeyboardInterrupt:
    return 0
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
