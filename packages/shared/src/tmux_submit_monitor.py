#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import subprocess
import time


IGNORED_COMMANDS = {
  "cat",
  "ps",
  "read",
  "screen",
  "slurmstepd",
  "srun",
  "tail",
  "tmesh",
  "tmux",
}

SHELL_COMMANDS = {"bash", "sh", "zsh", "fish"}


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="TensorMesh submitted tmux job monitor")
  parser.add_argument("--job", required=True)
  parser.add_argument("--socket", required=True)
  parser.add_argument("--session", required=True)
  parser.add_argument("--pane", required=True)
  parser.add_argument("--interval", type=float, default=5.0)
  parser.add_argument("--idle-grace", type=int, default=2)
  parser.add_argument("--check", action="store_true")
  return parser.parse_args()


def proc_command(pid: str) -> str:
  try:
    return Path("/proc", pid, "comm").read_text(encoding="utf-8", errors="replace").strip()
  except OSError:
    return ""


def proc_cmdline(pid: str) -> str:
  try:
    raw = Path("/proc", pid, "cmdline").read_bytes().replace(b"\x00", b" ").strip()
    return raw.decode("utf-8", errors="replace")
  except OSError:
    return ""


def pid_in_job(pid: str, job_id: str) -> bool:
  try:
    cgroup = Path("/proc", pid, "cgroup").read_text(encoding="utf-8", errors="replace")
  except OSError:
    return False
  return f"job_{job_id}" in cgroup or f"/job/{job_id}" in cgroup


def interactive_shell_process(command: str, cmdline: str) -> bool:
  command_base = os.path.basename(command).lstrip("-")
  if command_base not in SHELL_COMMANDS:
    return False
  try:
    tokens = shlex.split(cmdline)
  except ValueError:
    tokens = cmdline.split()
  if not tokens:
    return True
  shell = os.path.basename(tokens[0]).lstrip("-")
  if shell not in SHELL_COMMANDS:
    return False
  rest = tokens[1:]
  if not rest:
    return True
  if rest == ["-i"]:
    return True
  if len(rest) >= 3 and rest[0] == "--rcfile" and rest[-1] == "-i":
    return True
  return False


def work_pids(job_id: str) -> list[tuple[str, str]]:
  result: list[tuple[str, str]] = []
  for proc in Path("/proc").iterdir():
    if not proc.name.isdigit():
      continue
    pid = proc.name
    if not pid_in_job(pid, job_id):
      continue
    command = proc_command(pid)
    if not command or command in IGNORED_COMMANDS:
      continue
    cmdline = proc_cmdline(pid)
    if interactive_shell_process(command, cmdline):
      continue
    if "tmux_submit_monitor.py" in cmdline or "tmux_command_prompt.py" in cmdline:
      continue
    result.append((pid, command))
  return result


def tmux(args: argparse.Namespace, *tmux_args: str) -> None:
  subprocess.run(["tmux", "-L", args.socket, *tmux_args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def monitor(args: argparse.Namespace) -> int:
  idle = 0
  saw_work = False
  while True:
    pids = work_pids(args.job)
    if pids:
      saw_work = True
      idle = 0
    elif saw_work:
      idle += 1
      if idle >= args.idle_grace:
        tmux(args, "send-keys", "-t", args.pane, "exit", "C-m")
        return 0

    if not session_exists(args):
      return 0
    time.sleep(max(1.0, args.interval))


def session_exists(args: argparse.Namespace) -> bool:
  return subprocess.run(
    ["tmux", "-L", args.socket, "has-session", "-t", args.session],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    check=False,
  ).returncode == 0


def main() -> int:
  args = parse_args()
  if args.check:
    pids = work_pids(args.job)
    if pids:
      print(", ".join(f"{pid}:{command}" for pid, command in pids))
      return 0
    print("no running work process")
    return 1
  return monitor(args)


if __name__ == "__main__":
  raise SystemExit(main())
