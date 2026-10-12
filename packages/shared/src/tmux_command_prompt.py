#!/usr/bin/env python3
from __future__ import annotations

import argparse
import readline
import os
import subprocess
import sys


COMMANDS: list[tuple[str, str]] = [
  ("job", "show current Slurm job"),
  ("jobs", "show all Slurm jobs"),
  ("status", "show TensorMesh status"),
  ("log", "tail current bash.log"),
  ("notice", "open notice settings"),
  ("notice on", "enable notice for current job"),
  ("notice off", "disable notice for current job"),
  ("close", "detach this terminal from the shared shell"),
  ("cancel", "cancel current Slurm job"),
  ("submit", "detach current TensorMesh tmux and keep work running"),
  ("help", "show command help"),
]


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="TensorMesh tmux command prompt")
  parser.add_argument("--socket", required=True)
  parser.add_argument("--tmesh", required=True)
  parser.add_argument("--mode-script", required=True)
  parser.add_argument("--session", default="")
  parser.add_argument("--job", default="")
  parser.add_argument("--log", default="")
  parser.add_argument("--target-pane", required=True)
  return parser.parse_args()


def tmux_value(socket: str, *args: str) -> str:
  result = subprocess.run(
    ["tmux", "-L", socket, *args],
    text=True,
    capture_output=True,
    check=False,
  )
  return result.stdout.strip() if result.returncode == 0 else ""


def hydrate_args(args: argparse.Namespace) -> argparse.Namespace:
  pane = os.environ.get("TMUX_PANE", "")
  if args.target_pane == "self":
    args.target_pane = pane
  if pane and not getattr(args, "prompt_pane", ""):
    args.prompt_pane = pane
  if not args.session and pane:
    args.session = tmux_value(args.socket, "display-message", "-p", "-t", pane, "#{session_name}")
  if not args.job and args.session:
    args.job = tmux_value(args.socket, "show-options", "-v", "-t", args.session, "@tmesh_slurm_job")
  if not args.log and args.session:
    args.log = tmux_value(args.socket, "show-options", "-v", "-t", args.session, "@tmesh_log")
  if not args.target_pane:
    args.target_pane = args.session
  return args


def parent_pane(socket: str, pane: str) -> str:
  if not pane:
    return ""
  pane_top = tmux_value(socket, "display-message", "-p", "-t", pane, "#{pane_top}")
  panes = tmux_value(
    socket,
    "list-panes",
    "-F",
    "#{pane_id}|#{pane_top}|#{pane_height}|#{pane_active}",
  )
  candidates: list[tuple[int, str]] = []
  try:
    prompt_top = int(pane_top)
  except ValueError:
    prompt_top = 0
  for line in panes.splitlines():
    parts = line.split("|")
    if len(parts) != 4:
      continue
    pane_id, top, height, _active = parts
    if pane_id == pane:
      continue
    try:
      pane_bottom = int(top) + int(height)
    except ValueError:
      continue
    if pane_bottom <= prompt_top:
      candidates.append((pane_bottom, pane_id))
  if candidates:
    return sorted(candidates, reverse=True)[0][1]
  return ""


def install_completion() -> None:
  names = [name for name, _desc in COMMANDS]

  def complete(text: str, state: int) -> str | None:
    stripped = text.strip()
    matches = [name for name in names if name.startswith(stripped)]
    if stripped == "j":
      matches = ["job", "jobs"]
    if stripped == "n":
      matches = ["notice", "notice on", "notice off"]
    if stripped == "c":
      matches = ["close", "cancel"]
    try:
      return matches[state]
    except IndexError:
      return None

  readline.set_completer(complete)
  readline.parse_and_bind("set completion-ignore-case on")
  readline.parse_and_bind("set show-all-if-ambiguous on")
  readline.parse_and_bind("tab: menu-complete")


def print_hint() -> None:
  print("TensorMesh command mode")
  print("Tab cycles TensorMesh commands. Empty input resumes.")
  print()
  for name, desc in COMMANDS:
    print(f"  {name:<8} {desc}")
  print()


def main() -> int:
  args = hydrate_args(parse_args())
  command_target = parent_pane(args.socket, args.target_pane) or args.target_pane
  install_completion()
  print_hint()

  try:
    command = input("TensorMesh> ").strip()
  except (EOFError, KeyboardInterrupt):
    command = "resume"

  if not command:
    command = "resume"

  return subprocess.call([
    "bash",
    args.mode_script,
    args.socket,
    args.tmesh,
    command,
    args.session,
    command_target,
    args.job,
    args.log,
  ])


if __name__ == "__main__":
  raise SystemExit(main())
