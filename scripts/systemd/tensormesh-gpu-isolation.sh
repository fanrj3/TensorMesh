#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${1:?usage: tensormesh-gpu-isolation.sh <user> [daemon]}"
ACTION="${2:-apply}"
CGROUP="/sys/fs/cgroup/devices/tensormesh-${USER_NAME}-nogpu"
ROOT_CGROUP="/sys/fs/cgroup/devices"
INTERVAL="${TMESH_GPU_ISOLATION_INTERVAL:-0.5}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0 ${USER_NAME}" >&2
  exit 1
fi

if ! id "${USER_NAME}" >/dev/null 2>&1; then
  echo "User does not exist: ${USER_NAME}" >&2
  exit 1
fi

usage() {
  cat >&2 <<EOF
Usage:
  sudo $0 USER apply
  sudo $0 USER daemon
  sudo $0 USER restore

apply   Move current non-Slurm USER processes into the no-GPU cgroup once.
daemon  Keep applying the rule so new login shells are also restricted.
restore Move current USER processes back to ${ROOT_CGROUP}; stop the systemd service first.
EOF
}

discover_nvidia_majors() {
  shopt -s nullglob
  declare -gA nvidia_majors=()
  for device in /dev/nvidia* /dev/nvidia-caps/*; do
    [[ -c "${device}" ]] || continue
    major_hex="$(stat -c '%t' "${device}")"
    [[ -n "${major_hex}" ]] || continue
    nvidia_majors[$((16#${major_hex}))]=1
  done
}

configure_cgroup() {
  mkdir -p "${CGROUP}"
  echo 'a' > "${CGROUP}/devices.allow"

  discover_nvidia_majors
  for major in "${!nvidia_majors[@]}"; do
    echo "c ${major}:* rwm" > "${CGROUP}/devices.deny"
  done
}

is_slurm_process() {
  local pid="$1"
  [[ -r "/proc/${pid}/cgroup" ]] || return 1
  grep -qE 'slurm(_|/)|/job_[0-9]+' "/proc/${pid}/cgroup"
}

move_user_processes() {
  local moved=0
  mapfile -t pids < <(pgrep -u "${USER_NAME}" || true)
  for pid in "${pids[@]}"; do
    [[ -e "/proc/${pid}" ]] || continue
    if is_slurm_process "${pid}"; then
      continue
    fi
    if echo "${pid}" > "${CGROUP}/tasks" 2>/dev/null; then
      moved=$((moved + 1))
    fi
  done
  echo "${moved}"
}

restore_user_processes() {
  mapfile -t pids < <(pgrep -u "${USER_NAME}" || true)
  for pid in "${pids[@]}"; do
    if [[ -e "/proc/${pid}" ]]; then
      echo "${pid}" > "${ROOT_CGROUP}/tasks" 2>/dev/null || true
    fi
  done
  echo "Moved current ${USER_NAME} processes back to ${ROOT_CGROUP}."
}

case "${ACTION}" in
  restore)
    restore_user_processes
    ;;
  apply)
    configure_cgroup
    moved="$(move_user_processes)"
    echo "Applied no-GPU devices cgroup to ${moved} non-Slurm processes for ${USER_NAME}."
    echo "This affects current processes only. Use daemon/systemd mode for persistence."
    ;;
  daemon)
    echo "Starting persistent TensorMesh GPU isolation for ${USER_NAME}; interval=${INTERVAL}s; cgroup=${CGROUP}"
    while true; do
      configure_cgroup
      moved="$(move_user_processes)"
      echo "$(date --iso-8601=seconds) moved=${moved}"
      sleep "${INTERVAL}"
    done
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    usage
    exit 1
    ;;
esac
