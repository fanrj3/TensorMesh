#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${TMESH_NO_GPU_CONFIG_DIR:-/etc/tensormesh}"
USER_FILE="${TMESH_NO_GPU_USER_FILE:-${CONFIG_DIR}/no-gpu-users}"
LOGIN_NODE_FILE="${TMESH_LOGIN_NODE_FILE:-${CONFIG_DIR}/login-node-policy}"
DEVICES_ROOT="${TMESH_NO_GPU_DEVICES_ROOT:-/sys/fs/cgroup/devices}"
CPU_ROOT="${TMESH_LOGIN_CPU_ROOT:-/sys/fs/cgroup/cpu,cpuacct}"
CPU_CORES="${TMESH_LOGIN_CPU_CORES:-4}"
CPU_POLICY="${TMESH_LOGIN_CPU_POLICY:-off}"
LOG_FILE="${TMESH_NO_GPU_LOG_FILE:-/var/log/tensormesh-no-gpu-session.log}"

log() {
  local message="$1"
  printf '%s %s\n' "$(date --iso-8601=seconds)" "${message}" >> "${LOG_FILE}" 2>/dev/null || true
}

is_allowed_user() {
  local user="$1"
  if [[ -r "${LOGIN_NODE_FILE}" ]]; then
    return 0
  fi
  [[ -r "${USER_FILE}" ]] || return 1
  grep -Ev '^\s*(#|$)' "${USER_FILE}" | grep -Fxq "${user}"
}

discover_nvidia_majors() {
  shopt -s nullglob
  declare -gA nvidia_majors=()
  for device in /dev/nvidia* /dev/nvidia-caps/*; do
    [[ -c "${device}" ]] || continue
    local major_hex
    major_hex="$(stat -c '%t' "${device}")"
    [[ -n "${major_hex}" ]] || continue
    nvidia_majors[$((16#${major_hex}))]=1
  done
}

login_node_cgroup() {
  printf 'user.slice\n'
}

controller_cgroup() {
  local root="$1"
  local user="$2"
  local uid
  uid="$(id -u "${user}")"
  local per_user="user.slice/user-${uid}.slice"
  if [[ -d "${root}/${per_user}" ]]; then
    printf '%s\n' "${per_user}"
    return
  fi
  printf 'user.slice\n'
}

wait_for_cgroup() {
  local path="$1"
  local attempts=20
  while ((attempts > 0)); do
    [[ -d "${path}" ]] && return 0
    sleep 0.1
    attempts=$((attempts - 1))
  done
  [[ -d "${path}" ]]
}

apply_device_limits() {
  local user="$1"
  local relative
  relative="$(controller_cgroup "${DEVICES_ROOT}" "${user}")"
  local cgroup="${DEVICES_ROOT}/${relative}"
  wait_for_cgroup "${cgroup}" || return 1

  discover_nvidia_majors
  for major in "${!nvidia_majors[@]}"; do
    echo "c ${major}:* rwm" > "${cgroup}/devices.deny"
  done
  printf '%s\n' "${cgroup}"
}

apply_cpu_limits() {
  local user="$1"
  local relative
  relative="$(controller_cgroup "${CPU_ROOT}" "${user}")"
  if [[ "${CPU_POLICY}" != "shared" && "${relative}" == "user.slice" ]]; then
    printf 'skipped shared user.slice cpu policy disabled\n'
    return 0
  fi
  local cgroup="${CPU_ROOT}/${relative}"
  wait_for_cgroup "${cgroup}" || return 1
  local period=100000
  local quota
  quota="$(awk -v cores="${CPU_CORES}" -v period="${period}" 'BEGIN { printf "%d", cores * period }')"
  echo "${period}" > "${cgroup}/cpu.cfs_period_us"
  echo "${quota}" > "${cgroup}/cpu.cfs_quota_us"
  printf '%s quota=%s period=%s\n' "${cgroup}" "${quota}" "${period}"
}

main() {
  local session_type="${PAM_TYPE:-}"
  local user="${PAM_USER:-${USER:-}}"

  if [[ "${session_type}" != "open_session" ]]; then
    exit 0
  fi
  if [[ -z "${user}" ]]; then
    exit 0
  fi
  if ! is_allowed_user "${user}"; then
    exit 0
  fi
  if [[ "$(id -u "${user}")" -eq 0 ]]; then
    exit 0
  fi

  local device_result="unavailable"
  local cpu_result="unavailable"
  device_result="$(apply_device_limits "${user}" 2>/dev/null || true)"
  cpu_result="$(apply_cpu_limits "${user}" 2>/dev/null || true)"
  log "user=${user} pam_service=${PAM_SERVICE:-unknown} helper_pid=$$ devices=${device_result:-failed} cpu=${cpu_result:-failed}"
}

main "$@"
