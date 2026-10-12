#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
from datetime import datetime
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import tty
import time
import unicodedata
from pathlib import Path


JOB_PATTERNS = [
  re.compile(r"TensorMesh interactive job\s+(\d+)"),
  re.compile(r"srun: job\s+(\d+)")
]

ALLOCATED_PATTERNS = [
  re.compile(r"TensorMesh interactive job\s+(\d+)"),
  re.compile(r"srun: job\s+(\d+)\s+has been allocated resources"),
  re.compile(r"srun: Granted job allocation\s+(\d+)")
]

INFO = "\x1b[36m"
WARN = "\x1b[33m"
BAD = "\x1b[31m"
MUTED = "\x1b[90m"
BOLD = "\x1b[1m"
RESET = "\x1b[0m"
STATUS_BG = "\x1b[48;5;236m"
STATUS_HI = "\x1b[48;5;28m\x1b[97m"
STATUS_CMD = "\x1b[48;5;24m\x1b[97m"
TERMINAL_STATUS_ROWS = 1
COMMAND_PANEL_ROWS = 6

COMMAND_SUGGESTIONS: list[tuple[str, str]] = [
  ("submit", "后台提交当前正在运行的交互任务"),
  ("job", "查看当前 Slurm job"),
  ("jobs", "查看所有 Slurm jobs"),
  ("status", "查看 TensorMesh 状态"),
  ("notice on", "开启当前 job 邮件提醒"),
  ("notice off", "关闭当前 job 邮件提醒"),
  ("send ", "向 bash 发送一行命令"),
  ("cancel", "取消当前交互 job"),
  ("resume", "返回终端模式"),
]

CONTROL_SEQUENCE_RE = re.compile(
  rb"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]"
)


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="TensorMesh interactive Slurm PTY wrapper")
  parser.add_argument("--repo-root", required=True)
  parser.add_argument("--cwd", default=os.getcwd())
  parser.add_argument("srun_args", nargs=argparse.REMAINDER)
  args = parser.parse_args()
  if args.srun_args and args.srun_args[0] == "--":
    args.srun_args = args.srun_args[1:]
  return args


def write_stdout(text: str) -> None:
  os.write(sys.stdout.fileno(), text.encode("utf-8", errors="replace"))


def display_width(text: str) -> int:
  width = 0
  for char in text:
    if unicodedata.combining(char):
      continue
    width += 2 if unicodedata.east_asian_width(char) in {"F", "W"} else 1
  return width


def truncate_cells(text: str, width: int, ellipsis: bool = False) -> str:
  if width <= 0:
    return ""
  if display_width(text) <= width:
    return text
  marker = "…" if ellipsis and width > 1 else ""
  limit = max(0, width - display_width(marker))
  result = ""
  used = 0
  for char in text:
    char_width = 0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in {"F", "W"} else 1)
    if used + char_width > limit:
      break
    result += char
    used += char_width
  return result + marker


def pad_cells(text: str, width: int) -> str:
  clipped = truncate_cells(text, width)
  return clipped + " " * max(0, width - display_width(clipped))


def clean_log_bytes(data: bytes) -> bytes:
  cleaned = CONTROL_SEQUENCE_RE.sub(b"", data)
  cleaned = cleaned.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
  return re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", b"", cleaned)


def terminal_size() -> tuple[int, int]:
  size = shutil.get_terminal_size((120, 32))
  return size.lines, size.columns


def content_size() -> tuple[int, int]:
  rows, cols = terminal_size()
  return max(1, rows - TERMINAL_STATUS_ROWS), cols


def set_pty_size(fd: int) -> None:
  rows, cols = content_size()
  packed = struct.pack("HHHH", rows, cols, 0, 0)
  try:
    termios.tcsetwinsize(fd, (rows, cols))
  except AttributeError:
    import fcntl
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
  except OSError:
    pass


def apply_scroll_region() -> None:
  rows, _cols = content_size()
  write_stdout(f"\x1b[1;{rows}r")


def reset_scroll_region() -> None:
  write_stdout("\x1b[r")


def clear_terminal_for_wrapper() -> None:
  write_stdout("\x1b[2J\x1b[H")


def terminal_status_line() -> int:
  rows, _cols = terminal_size()
  return max(1, rows)


def command_panel_top() -> int:
  rows, _cols = terminal_size()
  return max(1, rows - COMMAND_PANEL_ROWS + 1)


def clear_terminal_status() -> None:
  _rows, cols = terminal_size()
  write_stdout(
    f"\x1b[s"
    f"\x1b[{terminal_status_line()};1H{RESET}\x1b[2K"
    f"\x1b[u"
  )


def clear_command_panel() -> None:
  rows, _cols = terminal_size()
  top = command_panel_top()
  write_stdout("\x1b[s")
  for row in range(top, rows + 1):
    write_stdout(f"\x1b[{row};1H{RESET}\x1b[2K")
  write_stdout("\x1b[u")


def clear_content_area() -> None:
  rows, _cols = content_size()
  write_stdout("\x1b[1;1H")
  for row in range(1, rows + 1):
    write_stdout(f"\x1b[{row};1H{RESET}\x1b[2K")
  write_stdout("\x1b[1;1H")


def detect_job_id(buffer: str) -> str:
  for pattern in JOB_PATTERNS:
    match = pattern.search(buffer)
    if match:
      return match.group(1)
  return ""


def detect_allocated(buffer: str) -> bool:
  return any(pattern.search(buffer) for pattern in ALLOCATED_PATTERNS)


def run_tmesh(repo_root: Path, args: list[str]) -> int:
  tmesh = repo_root / "bin" / "tmesh"
  try:
    return subprocess.call([str(tmesh), *args], cwd=repo_root)
  except FileNotFoundError:
    return subprocess.call(["node", "--import", "tsx", str(repo_root / "apps" / "cli" / "src" / "index.ts"), *args], cwd=repo_root)


def terminate_process_group(child: subprocess.Popen[bytes], sig: int = signal.SIGTERM) -> None:
  if child.poll() is not None:
    return
  try:
    os.killpg(child.pid, sig)
  except OSError:
    try:
      child.terminate()
    except OSError:
      pass


def cancel_detected_job(repo_root: Path, state: dict[str, object], quiet: bool = False) -> None:
  job_id = str(state.get("job_id", ""))
  if not job_id:
    return
  if state.get("cancelled_job") == job_id:
    return
  state["cancelled_job"] = job_id
  marker_dir = repo_root / "tmp" / "cancelled-jobs"
  try:
    marker_dir.mkdir(parents=True, exist_ok=True)
    (marker_dir / f"{re.sub(r'[^0-9A-Za-z_.-]', '_', job_id)}.json").write_text(
      json.dumps({"jobId": job_id, "reason": "interactive-exit", "markedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) + "\n",
      encoding="utf-8",
    )
  except OSError:
    pass
  if quiet:
    subprocess.run(
      ["scancel", job_id],
      cwd=repo_root,
      stdout=subprocess.DEVNULL,
      stderr=subprocess.DEVNULL,
      check=False,
    )
    return
  termios_state = state.get("termios")
  try:
    if termios_state is not None:
      termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, termios_state)
    run_tmesh(repo_root, ["cancel", job_id])
  finally:
    try:
      tty.setraw(sys.stdin.fileno())
    except termios.error:
      pass


def read_escape_tail(stdin_fd: int, timeout: float = 0.05) -> bytes:
  ready, _, _ = select.select([stdin_fd], [], [], timeout)
  if not ready:
    return b""
  try:
    return os.read(stdin_fd, 1024)
  except OSError:
    return b""


def clear_line() -> None:
  write_stdout("\r\x1b[2K")


def bottom_message(message: str, tone: str = INFO) -> None:
  _rows, cols = terminal_size()
  text = pad_cells(message, max(1, cols - 1))
  write_stdout(f"\x1b[s\x1b[{terminal_status_line()};1H{STATUS_HI}{text}{RESET}\x1b[u")


def show_hint(message: str, tone: str = INFO) -> None:
  bottom_message(message, tone)


def format_gres_label(value: str) -> str:
  gres = value.strip()
  indexes = re.findall(r"gpu:gpu(\d+)", gres)
  if indexes:
    return ",".join(indexes)
  idx = re.search(r"IDX:([0-9,-]+)", gres)
  if idx:
    return idx.group(1)
  count = re.search(r"gpu:(\d+)", gres)
  if count:
    return count.group(1)
  return gres or "-"


def initial_metadata(srun_args: list[str]) -> dict[str, str]:
  metadata = {"gpus": "-", "memory": "-", "cpus": "-", "expect": "-"}
  for arg in srun_args:
    if arg.startswith("--gres="):
      metadata["gpus"] = format_gres_label(arg.split("=", 1)[1])
    elif arg.startswith("--mem="):
      metadata["memory"] = arg.split("=", 1)[1]
    elif arg.startswith("--cpus-per-task="):
      metadata["cpus"] = arg.split("=", 1)[1]
    elif arg.startswith("--comment="):
      metadata["expect"] = format_expect_from_comment(arg.split("=", 1)[1])
  return metadata


def status_summary(state: dict[str, object]) -> str:
  job_id = str(state.get("job_id", "")) or "?"
  gpus = str(state.get("gpus", "")) or "-"
  memory = str(state.get("memory", "")) or "-"
  cpus = str(state.get("cpus", "")) or "-"
  expect = str(state.get("expect", "")) or "-"
  stamp = time.strftime("%H:%M:%S")
  left = f"[T{job_id}] Terminal Mode   GPUs: {gpus}   Mem: {memory}   CPUs: {cpus}   Expect: {expect}"
  _rows, cols = terminal_size()
  width = max(1, cols - 1)
  left_width = display_width(left)
  stamp_width = display_width(stamp)
  if left_width + 1 + stamp_width > width:
    left = truncate_cells(left, max(1, width - stamp_width - 1), ellipsis=True)
    left_width = display_width(left)
  gap = max(1, width - left_width - stamp_width)
  return left + " " * gap + stamp


def draw_terminal_status(state: dict[str, object]) -> None:
  _rows, cols = terminal_size()
  width = max(1, cols - 1)
  status_text = pad_cells(status_summary(state), width)
  write_stdout(
    f"\x1b[s"
    f"\x1b[{terminal_status_line()};1H{STATUS_HI}{status_text}{RESET}"
    f"\x1b[u"
  )


def command_help(job_id: str) -> str:
  job = f"job={job_id}" if job_id else "job=detecting"
  return f"TensorMesh {job}   Esc command   :submit  :job  :jobs  :status  :notice on/off  :cancel"


def command_query(command: str) -> str:
  return command.strip().lstrip(":/").lower()


def command_candidates(command: str) -> list[tuple[str, str]]:
  query = command_query(command)
  if not query:
    return COMMAND_SUGGESTIONS
  matches = [(name, desc) for name, desc in COMMAND_SUGGESTIONS if name.startswith(query)]
  if matches:
    return matches
  return [(name, desc) for name, desc in COMMAND_SUGGESTIONS if query in name or query in desc.lower()]


def apply_completion(command: str, candidate: str) -> str:
  prefix = "/" if command.strip().startswith("/") else (":" if command.strip().startswith(":") else "")
  suffix = "" if candidate.endswith(" ") else " "
  return f"{prefix}{candidate}{suffix}"


def read_command_line(state: dict[str, object]) -> str:
  stdin_fd = sys.stdin.fileno()
  command = ""
  selected = 0
  write_stdout("\x1b[s")

  def draw() -> None:
    nonlocal selected
    rows, cols = terminal_size()
    candidates = command_candidates(command)
    if candidates:
      selected = max(0, min(selected, len(candidates) - 1))
    else:
      selected = 0
    job_id = str(state.get("job_id", "")) or "?"
    prompt = f"[T{job_id}] Command Mode   >> {command}"
    width = max(1, cols - 1)
    top = command_panel_top()
    write_stdout("\x1b[s")
    for row in range(top, rows + 1):
      write_stdout(f"\x1b[{row};1H{RESET}\x1b[2K")
    header = "Command Mode  Up/Down select  Tab complete  Enter run  Esc resume"
    write_stdout(f"\x1b[{top};1H{STATUS_BG}\x1b[37m{pad_cells(header, width)}{RESET}")
    visible = max(0, rows - top - 1)
    for offset, (name, desc) in enumerate(candidates[:visible]):
      row = top + 1 + offset
      selected_style = STATUS_CMD if offset == selected else STATUS_BG + "\x1b[37m"
      marker = ">" if offset == selected else " "
      text = f"{marker} {name.strip():<12} {desc}"
      write_stdout(f"\x1b[{row};1H{selected_style}{pad_cells(text, width)}{RESET}")
    if not candidates and visible > 0:
      write_stdout(f"\x1b[{top + 1};1H{STATUS_BG}\x1b[37m{pad_cells('No matching command', width)}{RESET}")
    write_stdout(f"\x1b[{rows};1H{STATUS_CMD}{pad_cells(prompt, width)}{RESET}")
    write_stdout("\x1b[u")

  def finish() -> None:
    clear_command_panel()
    draw_terminal_status(state)
    write_stdout("\x1b[u")

  draw()

  while True:
    char = os.read(stdin_fd, 1)
    if not char:
      finish()
      return "resume"
    if char in (b"\r", b"\n"):
      finish()
      candidates = command_candidates(command)
      if not command.strip() and candidates:
        return candidates[selected][0].strip()
      return command.strip()
    if char == b"\x03":
      finish()
      return "resume"
    if char == b"\x1b":
      tail = read_escape_tail(stdin_fd, 0.03)
      if tail.startswith(b"[A"):
        selected = max(0, selected - 1)
        draw()
        continue
      if tail.startswith(b"[B"):
        candidates = command_candidates(command)
        selected = min(max(0, len(candidates) - 1), selected + 1)
        draw()
        continue
      if tail.startswith(b"[C") or tail.startswith(b"[D"):
        continue
      finish()
      return "resume"
    if char in (b"\x7f", b"\b"):
      if command:
        command = command[:-1]
        draw()
      continue
    if char == b"\t":
      candidates = command_candidates(command)
      if candidates:
        command = apply_completion(command, candidates[selected][0])
        draw()
      continue
    try:
      text = char.decode("utf-8")
    except UnicodeDecodeError:
      continue
    if text.isprintable() or text == " ":
      command += text
      draw()


def pids_for_job(job_id: str) -> list[str]:
  if not job_id:
    return []
  marker = f"/job_{job_id}"
  pids: list[str] = []
  for proc in Path("/proc").iterdir():
    if not proc.name.isdigit():
      continue
    try:
      text = (proc / "cgroup").read_text(errors="ignore")
    except OSError:
      continue
    if marker in text:
      pids.append(proc.name)
  return sorted(set(pids), key=int)


def interactive_shell_process(comm: str, args: str) -> bool:
  if comm not in {"bash", "sh", "zsh", "fish"}:
    return False
  normalized = " ".join(args.split())
  return normalized in {
    "bash",
    "bash -i",
    "-bash",
    "sh",
    "sh -i",
    "-sh",
    "zsh",
    "zsh -i",
    "-zsh",
    "fish",
    "fish -i",
  }


def slurm_job_processes(job_id: str) -> list[dict[str, str]]:
  pids = pids_for_job(job_id)
  if not pids:
    return []

  try:
    ps = subprocess.run(
      ["ps", "-o", "pid=,ppid=,stat=,comm=,args=", "-p", ",".join(pids)],
      text=True,
      capture_output=True,
      timeout=3,
      check=False,
    )
  except Exception:
    return []

  rows: list[dict[str, str]] = []
  ignored = {"srun", "slurmstepd", "tmux", "screen", "ps", "sstat"}
  for line in ps.stdout.splitlines():
    parts = line.strip().split(None, 4)
    if len(parts) < 5:
      continue
    pid, ppid, stat, comm, args = parts
    if comm in ignored:
      continue
    if interactive_shell_process(comm, args):
      continue
    if "tmesh" in args or "slurm_interactive.py" in args:
      continue
    if stat.startswith("Z"):
      continue
    rows.append({"pid": pid, "ppid": ppid, "stat": stat, "comm": comm, "args": args})
  return rows


def has_running_work(job_id: str, state: dict[str, str]) -> tuple[bool, str]:
  rows = slurm_job_processes(job_id)
  if rows:
    preview = ", ".join(f"{row['comm']}:{row['pid']}" for row in rows[:3])
    return True, preview

  return False, "终端中没有检测到正在运行的任务"


def confirm(prompt: str) -> bool:
  write_stdout(f"{WARN}{prompt} [y/N]: {RESET}")
  answer = b""
  while True:
    char = os.read(sys.stdin.fileno(), 1)
    if char in (b"\r", b"\n"):
      write_stdout("\r\n")
      break
    if char == b"\x1b":
      write_stdout("\r\n")
      return False
    if char in (b"\x7f", b"\b"):
      if answer:
        answer = answer[:-1]
        write_stdout("\b \b")
      continue
    answer += char
    os.write(sys.stdout.fileno(), char)
  return answer.decode("utf-8", errors="ignore").strip().lower() in ("y", "yes")


def read_job_comment(job_id: str) -> str:
  try:
    result = subprocess.run(
      ["scontrol", "show", "job", job_id, "-o"],
      text=True,
      capture_output=True,
      timeout=3,
      check=False,
    )
  except Exception:
    return ""
  match = re.search(r"(?:^|\s)Comment=(\S*)", result.stdout)
  return match.group(1) if match else ""


def parse_tmesh_comment(comment: str) -> dict[str, object]:
  if not comment.startswith("tmesh:"):
    return {}
  try:
    parsed = json.loads(comment[len("tmesh:"):])
    return parsed if isinstance(parsed, dict) else {}
  except json.JSONDecodeError:
    return {}


def format_expect_from_comment(comment: str) -> str:
  payload = parse_tmesh_comment(comment)
  end_at = payload.get("estimatedEndAt")
  hours = payload.get("estimatedHours")
  if not isinstance(end_at, str) or not end_at:
    return "-"
  try:
    end_ts = datetime_from_iso(end_at)
  except ValueError:
    return "-"
  duration = ""
  if isinstance(hours, (int, float)) and hours > 0:
    duration = f"{int(hours)}h" if float(hours).is_integer() else f"{hours:.2f}".rstrip("0").rstrip(".") + "h"
  return f"{duration} {time.strftime('%m-%d %H:%M', time.localtime(end_ts))}".strip()


def datetime_from_iso(value: str) -> float:
  normalized = value.replace("Z", "+00:00")
  return datetime.fromisoformat(normalized).timestamp()


def parse_scontrol_key_values(output: str) -> dict[str, str]:
  values: dict[str, str] = {}
  for match in re.finditer(r"(\S+?)=([^\s]*)", output):
    values[match.group(1)] = match.group(2)
  return values


def update_job_metadata(state: dict[str, object]) -> None:
  job_id = str(state.get("job_id", ""))
  if not job_id:
    return
  now = time.time()
  last = float(state.get("metadata_checked_at", 0) or 0)
  if now - last < 5:
    return
  state["metadata_checked_at"] = now
  try:
    result = subprocess.run(
      ["scontrol", "show", "job", job_id, "--details"],
      text=True,
      capture_output=True,
      timeout=3,
      check=False,
    )
  except Exception:
    return
  if result.returncode != 0:
    return
  values = parse_scontrol_key_values(result.stdout)
  state["memory"] = values.get("MinMemoryNode") or values.get("Mem") or state.get("memory", "-")
  state["cpus"] = values.get("NumCPUs") or state.get("cpus", "-")
  gres = values.get("GRES") or values.get("TresPerNode") or values.get("TRES") or ""
  if gres:
    state["gpus"] = gres.replace("gpu:", "").replace("(IDX:", "[").replace(")", "]")
  comment = values.get("Comment") or ""
  if comment:
    state["expect"] = format_expect_from_comment(comment)


def update_notice_comment(job_id: str, enabled: bool) -> tuple[bool, str]:
  comment = read_job_comment(job_id)
  payload = parse_tmesh_comment(comment)
  payload["notice"] = enabled
  if "description" in payload and "descriptionB64" not in payload:
    raw_description = str(payload.get("description", "")).strip()
    if raw_description:
      payload["descriptionB64"] = base64.urlsafe_b64encode(raw_description.encode("utf-8")).decode("ascii").rstrip("=")
    payload.pop("description", None)
  next_comment = "tmesh:" + json.dumps(payload, separators=(",", ":"))
  result = subprocess.run(
    ["scontrol", "update", f"JobId={job_id}", f"Comment={next_comment}"],
    text=True,
    capture_output=True,
    check=False,
  )
  if result.returncode != 0:
    return False, (result.stderr or result.stdout or "scontrol update failed").strip()
  return True, "enabled" if enabled else "off"


def redraw_shell_prompt(master_fd: int) -> None:
  try:
    os.write(master_fd, b"\n")
  except OSError:
    pass


def run_tmesh_panel(repo_root: Path, args: list[str]) -> int:
  reset_scroll_region()
  clear_command_panel()
  clear_content_area()
  code = run_tmesh(repo_root, args)
  write_stdout("\r\n")
  apply_scroll_region()
  return code


def prepare_submit_log(cwd: Path, job_id: str) -> Path:
  log_dir = cwd / ".tmesh" / job_id
  log_dir.mkdir(parents=True, exist_ok=True)
  return log_dir / "submit.log"


def daemonize_log(master_fd: int, submit_log: Path, job_id: str) -> None:
  pid = os.fork()
  if pid > 0:
    return

  os.setsid()
  devnull = os.open("/dev/null", os.O_RDWR)
  for fd in (0, 1, 2):
    try:
      os.dup2(devnull, fd)
    except OSError:
      pass
  try:
    with submit_log.open("ab", buffering=0) as log:
      while True:
        has_work, _detail = has_running_work(job_id, {})
        if not has_work:
          try:
            os.write(master_fd, b"\nexit\n")
          except OSError:
            pass
        try:
          chunk = os.read(master_fd, 4096)
        except OSError:
          break
        if not chunk:
          break
        log.write(clean_log_bytes(chunk))
  finally:
    os._exit(0)


def handle_command(
  command: str,
  master_fd: int,
  child: subprocess.Popen[bytes],
  repo_root: Path,
  cwd: Path,
  state: dict[str, str],
) -> str:
  normalized = command.strip()
  if normalized.startswith(":") or normalized.startswith("/"):
    normalized = normalized[1:].strip()
  if normalized in ("", "resume", "q", "quit"):
    show_hint("[TensorMesh] resumed", MUTED)
    return "resume"

  if normalized == "help":
    show_hint(command_help(state.get("job_id", "")), MUTED)
    return "resume"

  if normalized.startswith("send "):
    shell_command = normalized[5:].strip()
    if shell_command:
      os.write(master_fd, shell_command.encode("utf-8") + b"\n")
    return "resume"

  if normalized == "jobs":
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, state["termios"])
    run_tmesh_panel(repo_root, ["jobs", "--all"])
    tty.setraw(sys.stdin.fileno())
    redraw_shell_prompt(master_fd)
    return "resume"

  if normalized == "status":
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, state["termios"])
    run_tmesh_panel(repo_root, ["status"])
    tty.setraw(sys.stdin.fileno())
    redraw_shell_prompt(master_fd)
    return "resume"

  if normalized == "job" or normalized.startswith("job "):
    job_id = normalized[4:].strip() if normalized.startswith("job ") else state.get("job_id", "")
    if not job_id:
      show_hint("Job id has not been detected yet.", BAD)
      return "resume"
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, state["termios"])
    run_tmesh_panel(repo_root, ["job", job_id])
    tty.setraw(sys.stdin.fileno())
    redraw_shell_prompt(master_fd)
    return "resume"

  if normalized == "notice" or normalized.startswith("notice "):
    job_id = state.get("job_id", "")
    if not job_id:
      show_hint("Job id has not been detected yet.", BAD)
      return "resume"
    raw_value = normalized[7:].strip().lower() if normalized.startswith("notice ") else ""
    if raw_value in ("on", "true", "1", "yes"):
      enabled = True
    elif raw_value in ("off", "false", "0", "no"):
      enabled = False
    else:
      current = read_job_comment(str(job_id))
      current_notice = False
      if current.startswith("tmesh:"):
        try:
          parsed = json.loads(current[len("tmesh:"):])
          current_notice = bool(parsed.get("notice")) if isinstance(parsed, dict) else False
        except json.JSONDecodeError:
          current_notice = False
      enabled = not current_notice
    ok, message = update_notice_comment(str(job_id), enabled)
    show_hint(f"notice {message}" if ok else f"notice update failed: {message}", INFO if ok else BAD)
    redraw_shell_prompt(master_fd)
    return "resume"

  if normalized == "cancel" or normalized.startswith("cancel "):
    job_id = normalized[7:].strip() if normalized.startswith("cancel ") else state.get("job_id", "")
    if not job_id:
      show_hint("Job id has not been detected yet.", BAD)
      return "resume"
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, state["termios"])
    code = run_tmesh_panel(repo_root, ["cancel", job_id])
    tty.setraw(sys.stdin.fileno())
    if code == 0:
      return "terminate"
    show_hint("cancel aborted", MUTED)
    redraw_shell_prompt(master_fd)
    return "resume"

  if normalized == "submit":
    job_id = state.get("job_id", "")
    if not job_id:
      show_hint("无法提交：还没有定位当前 Slurm job，稍后再试", BAD)
      return "resume"
    has_work, detail = has_running_work(job_id, state)
    if not has_work:
      show_hint(f"无法提交：{detail}", BAD)
      redraw_shell_prompt(master_fd)
      return "resume"
    if not confirm(f"Submit current interactive job {job_id} as background task ({detail})?"):
      show_hint("submit aborted", MUTED)
      return "resume"
    submit_log = prepare_submit_log(cwd, job_id)
    transcript_path = state.get("transcript_path", "")
    transcript = state.get("transcript")
    if transcript:
      transcript.flush()
    if transcript_path and Path(transcript_path).exists():
      transcript_file = Path(transcript_path)
      submit_log.write_bytes(clean_log_bytes(transcript_file.read_bytes()))
      try:
        transcript_file.unlink()
      except OSError:
        pass
    state["submit_log"] = str(submit_log)
    show_hint(f"Submitted. Output continues in {submit_log}", INFO)
    return "detach"

  if normalized in ("detach", "detatch", "detech"):
    show_hint("detach 已合并到 submit：只有确认 submit 后才会后台保留当前作业", WARN)
    return "resume"

  show_hint(f"Unknown command: {normalized}", BAD)
  return "resume"


def run_plain(srun_args: list[str], cwd: str) -> int:
  try:
    return subprocess.call([os.environ.get("TENSORMESH_SRUN", "srun"), *srun_args], cwd=cwd)
  except FileNotFoundError:
    print("Slurm command not found: srun. Install Slurm client tools first.", file=sys.stderr)
    return 127


def run_wrapped(args: argparse.Namespace) -> int:
  repo_root = Path(args.repo_root).resolve()
  cwd = Path(args.cwd).resolve()

  if not sys.stdin.isatty() or not sys.stdout.isatty():
    return run_plain(args.srun_args, args.cwd)

  master_fd, slave_fd = pty.openpty()
  set_pty_size(slave_fd)
  child = subprocess.Popen(
    [os.environ.get("TENSORMESH_SRUN", "srun"), *args.srun_args],
    cwd=args.cwd,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
    preexec_fn=os.setsid,
  )
  os.close(slave_fd)

  stdin_fd = sys.stdin.fileno()
  stdout_fd = sys.stdout.fileno()
  original_termios = termios.tcgetattr(stdin_fd)
  state: dict[str, object] = {
    "job_id": "",
    "output_tail": "",
    "termios": original_termios,
    "submit_log": "",
    "allocated": False,
    "hint_shown": False,
    "cancelled_job": "",
    "metadata_checked_at": 0,
    **initial_metadata(args.srun_args),
  }
  shutdown_signal = {"value": 0}
  exit_reason = ""
  transcript_path = cwd / ".tmesh" / f".interactive-{os.getpid()}.log"
  transcript_path.parent.mkdir(parents=True, exist_ok=True)
  transcript = transcript_path.open("ab", buffering=0)
  state["transcript_path"] = str(transcript_path)
  state["transcript"] = transcript

  def cancel_and_stop(reason: str, sig: int = signal.SIGTERM, quiet: bool = True) -> None:
    nonlocal exit_reason
    exit_reason = reason
    if not state.get("submit_log"):
      cancel_detected_job(repo_root, state, quiet=quiet)
    terminate_process_group(child, sig)

  def handle_resize(_signum: int, _frame: object) -> None:
    set_pty_size(master_fd)
    try:
      os.killpg(child.pid, signal.SIGWINCH)
    except OSError:
      pass

  def handle_shutdown(signum: int, _frame: object) -> None:
    shutdown_signal["value"] = signum

  signal.signal(signal.SIGWINCH, handle_resize)
  signal.signal(signal.SIGHUP, handle_shutdown)
  signal.signal(signal.SIGTERM, handle_shutdown)
  tty.setraw(stdin_fd)
  clear_terminal_for_wrapper()
  apply_scroll_region()
  draw_terminal_status(state)

  try:
    while True:
      if shutdown_signal["value"]:
        cancel_and_stop("signal", int(shutdown_signal["value"]), quiet=True)
        break

      if child.poll() is not None:
        break

      update_job_metadata(state)
      draw_terminal_status(state)

      try:
        readable, _, _ = select.select([stdin_fd, master_fd], [], [], 0.1)
      except InterruptedError:
        continue

      if master_fd in readable:
        try:
          data = os.read(master_fd, 4096)
        except OSError:
          break
        if not data:
          break
        text = data.decode("utf-8", errors="ignore")
        state["output_tail"] = (str(state["output_tail"]) + text)[-5000:]
        transcript.write(data)
        if not state.get("job_id"):
          state["job_id"] = detect_job_id(str(state["output_tail"]))
        if not state.get("allocated") and detect_allocated(str(state["output_tail"])):
          state["allocated"] = True
        if state.get("allocated") and not state.get("hint_shown"):
          state["hint_shown"] = True
          draw_terminal_status(state)
        try:
          os.write(stdout_fd, data)
        except OSError:
          cancel_and_stop("disconnect", quiet=True)
          break

      if stdin_fd in readable:
        try:
          data = os.read(stdin_fd, 4096)
        except OSError:
          cancel_and_stop("disconnect", quiet=True)
          break
        if not data:
          cancel_and_stop("disconnect", quiet=True)
          break
        if b"\x03" in data and not state.get("allocated"):
          if state.get("job_id"):
            cancel_detected_job(repo_root, state, quiet=True)
          exit_reason = "interrupt"
          terminate_process_group(child, signal.SIGINT)
          break
        if data == b"\x1b":
          if not state.get("allocated"):
            os.write(master_fd, data)
            continue
          tail = read_escape_tail(stdin_fd)
          if tail:
            os.write(master_fd, data + tail)
            continue
          command = read_command_line(state)
          action = handle_command(command, master_fd, child, repo_root, cwd, state)
          if action == "terminate":
            break
          if action == "detach":
            submit_log = state.get("submit_log", "")
            if submit_log:
              transcript.close()
              daemonize_log(master_fd, Path(submit_log), state.get("job_id", ""))
              master_fd = -1
              return 0
            break
          continue
        try:
          os.write(master_fd, data)
        except OSError:
          break
  finally:
    reset_scroll_region()
    clear_command_panel()
    try:
      termios.tcsetattr(stdin_fd, termios.TCSADRAIN, original_termios)
    except (termios.error, OSError):
      pass
    if exit_reason in {"disconnect", "signal"}:
      cancel_detected_job(repo_root, state, quiet=True)
      terminate_process_group(child, signal.SIGTERM)
    try:
      if not transcript.closed:
        transcript.close()
    except Exception:
      pass
    if not state.get("submit_log"):
      try:
        transcript_path.unlink()
      except OSError:
        pass
    try:
      if master_fd >= 0:
        os.close(master_fd)
    except OSError:
      pass

  try:
    return child.wait() if child.poll() is None else int(child.returncode or 0)
  except KeyboardInterrupt:
    terminate_process_group(child, signal.SIGTERM)
    return 130


def main() -> int:
  args = parse_args()
  if not args.srun_args:
    print("No srun arguments provided.", file=sys.stderr)
    return 2
  try:
    return run_wrapped(args)
  except FileNotFoundError as error:
    print(f"Command not found: {error.filename}", file=sys.stderr)
    return 127


if __name__ == "__main__":
  raise SystemExit(main())
