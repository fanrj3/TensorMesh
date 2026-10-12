#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="TensorMesh external GPU process watcher")
  parser.add_argument("--owner", default=os.environ.get("USER", ""), help="Linux user whose GPU processes keep the job alive")
  parser.add_argument("--pids", default="", help="Optional comma-separated target PIDs")
  parser.add_argument("--poll", type=float, default=30.0, help="Polling interval in seconds")
  parser.add_argument("--idle-grace", type=int, default=2, help="Consecutive empty polls before exit")
  return parser.parse_args()


def parse_pid_set(value: str) -> set[str]:
  return {part.strip() for part in value.split(",") if part.strip().isdigit()}


def ps_user(pid: str) -> str:
  result = subprocess.run(
    ["ps", "-o", "user=", "-p", pid],
    text=True,
    capture_output=True,
    check=False,
  )
  return result.stdout.strip().splitlines()[0].strip() if result.stdout.strip() else ""


def query_compute_processes() -> list[dict[str, str]]:
  result = subprocess.run(
    [
      "nvidia-smi",
      "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
      "--format=csv,noheader,nounits",
    ],
    text=True,
    capture_output=True,
    check=False,
  )
  if result.returncode != 0:
    message = result.stderr.strip() or result.stdout.strip() or f"nvidia-smi exited with {result.returncode}"
    print(f"[TensorMesh bind] nvidia-smi unavailable: {message}", flush=True)
    return []

  rows: list[dict[str, str]] = []
  for line in result.stdout.splitlines():
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 4 or not parts[1].isdigit():
      continue
    rows.append({
      "gpu_uuid": parts[0],
      "pid": parts[1],
      "process_name": parts[2],
      "used_memory": parts[3],
      "user": ps_user(parts[1]),
    })
  return rows


def matching_processes(owner: str, target_pids: set[str]) -> list[dict[str, str]]:
  processes = query_compute_processes()
  if target_pids:
    return [process for process in processes if process["pid"] in target_pids]
  return [process for process in processes if process["user"] == owner]


def main() -> int:
  args = parse_args()
  owner = args.owner.strip()
  target_pids = parse_pid_set(args.pids)
  poll = max(1.0, args.poll)
  idle_grace = max(1, args.idle_grace)
  empty_count = 0

  if not owner and not target_pids:
    print("[TensorMesh bind] --owner is required when --pids is not provided", file=sys.stderr)
    return 2

  target = f"pids={','.join(sorted(target_pids))}" if target_pids else f"owner={owner}"
  print(f"[TensorMesh bind] watching external GPU processes: {target}", flush=True)
  print(f"[TensorMesh bind] poll={poll:g}s idle_grace={idle_grace}", flush=True)

  while True:
    matches = matching_processes(owner, target_pids)
    if matches:
      empty_count = 0
      summary = "; ".join(
        f"pid={item['pid']} user={item['user'] or '-'} mem={item['used_memory']}MiB cmd={item['process_name']}"
        for item in matches
      )
      print(f"[TensorMesh bind] alive: {summary}", flush=True)
    else:
      empty_count += 1
      print(f"[TensorMesh bind] no matching process ({empty_count}/{idle_grace})", flush=True)
      if empty_count >= idle_grace:
        print("[TensorMesh bind] external process disappeared; exiting Slurm lock job", flush=True)
        return 0
    time.sleep(poll)


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except KeyboardInterrupt:
    raise SystemExit(130)
