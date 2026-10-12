#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="/etc/tensormesh"
USER_FILE="${CONFIG_DIR}/no-gpu-users"
LOGIN_NODE_FILE="${CONFIG_DIR}/login-node-policy"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HELPER_SRC="${SCRIPT_DIR}/tensormesh-no-gpu-session.sh"
HELPER_DST="/usr/local/sbin/tensormesh-no-gpu-session"
# Debian/Ubuntu path; adjust for other distributions.
PAM_FILE="/etc/pam.d/common-session"
PAM_MARKER_BEGIN="# TensorMesh no-GPU session begin"
PAM_MARKER_END="# TensorMesh no-GPU session end"
PAM_LINE="session optional pam_exec.so quiet ${HELPER_DST}"
DEVICES_ROOT="/sys/fs/cgroup/devices"
CPU_ROOT="/sys/fs/cgroup/cpu,cpuacct"
CPU_CORES="${TMESH_LOGIN_CPU_CORES:-4}"
CPU_POLICY="${TMESH_LOGIN_CPU_POLICY:-off}"

usage() {
  cat <<EOF
Usage:
  sudo $0 install
  sudo $0 uninstall
  sudo $0 enable-login-node
  sudo $0 disable-login-node
  sudo $0 enable-user USER
  sudo $0 disable-user USER
  sudo $0 apply-user USER
  sudo $0 apply-login-node
  sudo $0 list
  sudo $0 restore-user USER
  sudo $0 restore-login-node

install        Install PAM helper and add pam_exec hook to ${PAM_FILE}.
uninstall      Remove PAM hook but keep ${USER_FILE}.
enable-login-node
               Enable default no-GPU policy for ordinary login sessions.
disable-login-node
               Disable the global login-node trigger; current cgroup limits remain until restored.
enable-user    Add one Linux user to trigger the default no-GPU login policy.
disable-user   Remove one Linux user from the default login policy.
apply-user     Apply no-GPU device deny to USER's login cgroups; CPU quota only when safe.
apply-login-node
               Apply no-GPU device deny to the shared login user.slice; CPU quota only when explicitly enabled.
list           Show users currently in the policy.
restore-user   Remove current login cgroup GPU deny and CPU quota; new sessions still follow policy.
restore-login-node
               Remove current shared login user.slice GPU deny and CPU quota.
EOF
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run with sudo." >&2
    exit 1
  fi
}

ensure_user() {
  local user="$1"
  if ! id "${user}" >/dev/null 2>&1; then
    echo "User does not exist: ${user}" >&2
    exit 1
  fi
}

install_hook() {
  install -d -m 755 "${CONFIG_DIR}"
  touch "${USER_FILE}"
  chmod 644 "${USER_FILE}"
  install -m 755 "${HELPER_SRC}" "${HELPER_DST}"

  cp -a "${PAM_FILE}" "${PAM_FILE}.tensormesh.bak.$(date +%Y%m%d%H%M%S)"
  local tmp_file
  local stripped_file
  tmp_file="$(mktemp)"
  stripped_file="$(mktemp)"
  sed "/^${PAM_MARKER_BEGIN}$/,/^${PAM_MARKER_END}$/d" "${PAM_FILE}" > "${stripped_file}"
  awk -v begin="${PAM_MARKER_BEGIN}" -v line="${PAM_LINE}" -v end="${PAM_MARKER_END}" '
    /pam_systemd\.so/ && !inserted {
      print begin;
      print line;
      print end;
      inserted = 1;
    }
    { print }
    END {
      if (!inserted) {
        print "";
        print begin;
        print line;
        print end;
      }
    }
  ' "${stripped_file}" > "${tmp_file}"
  install -m 644 "${tmp_file}" "${PAM_FILE}"
  rm -f "${tmp_file}" "${stripped_file}"
  echo "Installed TensorMesh PAM hook into ${PAM_FILE}."
}

uninstall_hook() {
  if ! grep -Fq "${PAM_MARKER_BEGIN}" "${PAM_FILE}"; then
    echo "PAM hook is not installed in ${PAM_FILE}."
    return
  fi

  cp -a "${PAM_FILE}" "${PAM_FILE}.tensormesh.bak.$(date +%Y%m%d%H%M%S)"
  sed -i "/^${PAM_MARKER_BEGIN}$/,/^${PAM_MARKER_END}$/d" "${PAM_FILE}"
  echo "Removed TensorMesh PAM hook from ${PAM_FILE}."
}

enable_user() {
  local user="$1"
  ensure_user "${user}"
  install -d -m 755 "${CONFIG_DIR}"
  touch "${USER_FILE}"
  chmod 644 "${USER_FILE}"
  if grep -Ev '^\s*(#|$)' "${USER_FILE}" | grep -Fxq "${user}"; then
    echo "${user} is already enabled."
    return
  fi
  printf '%s\n' "${user}" >> "${USER_FILE}"
  sort -u "${USER_FILE}" -o "${USER_FILE}"
  echo "Enabled default no-GPU login policy for ${user}."
}

enable_login_node() {
  install -d -m 755 "${CONFIG_DIR}"
  printf 'enabled\n' > "${LOGIN_NODE_FILE}"
  chmod 644 "${LOGIN_NODE_FILE}"
  echo "Enabled default no-GPU login-node policy."
}

disable_login_node() {
  rm -f "${LOGIN_NODE_FILE}"
  echo "Disabled default login-node policy trigger."
}

disable_user() {
  local user="$1"
  [[ -f "${USER_FILE}" ]] || return 0
  sed -i "/^${user}$/d" "${USER_FILE}"
  echo "Disabled default no-GPU login policy for ${user}."
}

list_users() {
  if [[ -f "${LOGIN_NODE_FILE}" ]]; then
    echo "login-node: enabled"
  else
    echo "login-node: disabled"
  fi
  if [[ ! -f "${USER_FILE}" ]]; then
    echo "No users configured."
    return
  fi
  echo "users:"
  grep -Ev '^\s*(#|$)' "${USER_FILE}" || true
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

ensure_cgroup() {
  local path="$1"
  if [[ ! -d "${path}" ]]; then
    echo "Cgroup does not exist yet: ${path}" >&2
    echo "Log in as the user first, or keep a user manager active with loginctl enable-linger." >&2
    exit 1
  fi
}

apply_device_cgroup() {
  local relative="$1"
  local cgroup="${DEVICES_ROOT}/${relative}"
  ensure_cgroup "${cgroup}"
  discover_nvidia_majors
  for major in "${!nvidia_majors[@]}"; do
    echo "c ${major}:* rwm" > "${cgroup}/devices.deny"
  done
  printf '%s\n' "${cgroup}"
}

apply_cpu_cgroup() {
  local relative="$1"
  if [[ "${CPU_POLICY}" != "shared" && "${relative}" == "user.slice" ]]; then
    printf '%s\n' "skipped shared user.slice cpu policy disabled"
    return 0
  fi
  local cgroup="${CPU_ROOT}/${relative}"
  ensure_cgroup "${cgroup}"
  local period=100000
  local quota
  quota="$(awk -v cores="${CPU_CORES}" -v period="${period}" 'BEGIN { printf "%d", cores * period }')"
  echo "${period}" > "${cgroup}/cpu.cfs_period_us"
  echo "${quota}" > "${cgroup}/cpu.cfs_quota_us"
  printf '%s quota=%s period=%s\n' "${cgroup}" "${quota}" "${period}"
}

apply_user() {
  local user="$1"
  ensure_user "${user}"
  local device_relative
  local cpu_relative
  device_relative="$(controller_cgroup "${DEVICES_ROOT}" "${user}")"
  cpu_relative="$(controller_cgroup "${CPU_ROOT}" "${user}")"
  local device_cgroup
  local cpu_cgroup
  device_cgroup="$(apply_device_cgroup "${device_relative}")"
  cpu_cgroup="$(apply_cpu_cgroup "${cpu_relative}")"
  echo "Applied no-GPU device deny to ${device_cgroup}."
  echo "Applied ${CPU_CORES}-core CPU quota to ${cpu_cgroup}."
}

apply_login_node() {
  local relative
  relative="$(login_node_cgroup)"
  local device_cgroup
  local cpu_cgroup
  device_cgroup="$(apply_device_cgroup "${relative}")"
  cpu_cgroup="$(apply_cpu_cgroup "${relative}")"
  echo "Applied no-GPU device deny to ${device_cgroup}."
  echo "Applied ${CPU_CORES}-core CPU quota to ${cpu_cgroup}."
}

restore_user() {
  local user="$1"
  ensure_user "${user}"
  local device_relative
  local cpu_relative
  device_relative="$(controller_cgroup "${DEVICES_ROOT}" "${user}")"
  cpu_relative="$(controller_cgroup "${CPU_ROOT}" "${user}")"
  local device_cgroup="${DEVICES_ROOT}/${device_relative}"
  local cpu_cgroup="${CPU_ROOT}/${cpu_relative}"
  if [[ -d "${device_cgroup}" ]]; then
    discover_nvidia_majors
    for major in "${!nvidia_majors[@]}"; do
      echo "c ${major}:* rwm" > "${device_cgroup}/devices.allow" 2>/dev/null || true
    done
  fi
  if [[ -d "${cpu_cgroup}" ]]; then
    echo -1 > "${cpu_cgroup}/cpu.cfs_quota_us" 2>/dev/null || true
  fi
  echo "Restored current ${user} login cgroup GPU device access and CPU quota."
}

restore_login_node() {
  local relative
  relative="$(login_node_cgroup)"
  local device_cgroup="${DEVICES_ROOT}/${relative}"
  local cpu_cgroup="${CPU_ROOT}/${relative}"
  if [[ -d "${device_cgroup}" ]]; then
    discover_nvidia_majors
    for major in "${!nvidia_majors[@]}"; do
      echo "c ${major}:* rwm" > "${device_cgroup}/devices.allow" 2>/dev/null || true
    done
  fi
  if [[ -d "${cpu_cgroup}" ]]; then
    echo -1 > "${cpu_cgroup}/cpu.cfs_quota_us" 2>/dev/null || true
  fi
  echo "Restored shared login user.slice GPU device access and CPU quota."
}

main() {
  require_root
  local action="${1:-}"
  case "${action}" in
    install)
      install_hook
      ;;
    uninstall)
      uninstall_hook
      ;;
    enable-login-node)
      [[ $# -eq 1 ]] || { usage >&2; exit 1; }
      enable_login_node
      ;;
    disable-login-node)
      [[ $# -eq 1 ]] || { usage >&2; exit 1; }
      disable_login_node
      ;;
    enable-user)
      [[ $# -eq 2 ]] || { usage >&2; exit 1; }
      enable_user "$2"
      ;;
    disable-user)
      [[ $# -eq 2 ]] || { usage >&2; exit 1; }
      disable_user "$2"
      ;;
    apply-user)
      [[ $# -eq 2 ]] || { usage >&2; exit 1; }
      apply_user "$2"
      ;;
    apply-login-node)
      [[ $# -eq 1 ]] || { usage >&2; exit 1; }
      apply_login_node
      ;;
    list)
      list_users
      ;;
    restore-user)
      [[ $# -eq 2 ]] || { usage >&2; exit 1; }
      restore_user "$2"
      ;;
    restore-login-node)
      [[ $# -eq 1 ]] || { usage >&2; exit 1; }
      restore_login_node
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
