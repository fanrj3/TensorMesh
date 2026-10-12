#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_SRC="${TMESH_NVIDIA_SMI_SHIM_SRC:-${SCRIPT_DIR}/nvidia-smi-notice.sh}"
SHIM_DST="/usr/local/bin/nvidia-smi"
SHIM_MARKER="TensorMesh nvidia-smi notice shim"

usage() {
  cat <<EOF
Usage:
  sudo $0 install
  sudo $0 uninstall
  $0 status

install        Install the TensorMesh notice shim to ${SHIM_DST}. GPU-isolated
               login shells then get an onboarding notice (tmesh status/run/
               bash) instead of a cryptic NVML error; root and Slurm jobs keep
               the real binary.
uninstall      Remove ${SHIM_DST} if it is the TensorMesh shim.
status         Show whether the shim is installed and which nvidia-smi wins.
EOF
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run with sudo." >&2
    exit 1
  fi
}

install_shim() {
  if [[ ! -f "${SHIM_SRC}" ]]; then
    echo "Shim source not found: ${SHIM_SRC}" >&2
    exit 1
  fi
  install -m 0755 "${SHIM_SRC}" "${SHIM_DST}"
  echo "Installed ${SHIM_DST} (source: ${SHIM_SRC})."
  echo "GPU-isolated users will now see the TensorMesh notice; root, Slurm jobs"
  echo "and 'TENSORMESH_NVIDIA_SMI_NOTICE=off nvidia-smi' pass through to the real binary."
}

uninstall_shim() {
  if [[ ! -e "${SHIM_DST}" ]]; then
    echo "${SHIM_DST} is not installed."
    return
  fi
  if ! grep -q "${SHIM_MARKER}" "${SHIM_DST}" 2>/dev/null; then
    echo "Refusing to remove ${SHIM_DST}: it exists but is not the TensorMesh shim." >&2
    exit 1
  fi
  rm -f "${SHIM_DST}"
  echo "Removed ${SHIM_DST}."
}

status_shim() {
  if [[ -e "${SHIM_DST}" ]]; then
    if grep -q "${SHIM_MARKER}" "${SHIM_DST}" 2>/dev/null; then
      echo "${SHIM_DST}: TensorMesh notice shim installed"
    else
      echo "${SHIM_DST}: present but NOT the TensorMesh shim"
    fi
    ls -l "${SHIM_DST}"
  else
    echo "${SHIM_DST}: not installed"
  fi
  local resolved
  resolved="$(command -v nvidia-smi || true)"
  if [[ -n "${resolved}" ]]; then
    echo "Resolved by PATH: ${resolved}"
  fi
}

case "${1:-}" in
  install)
    require_root
    install_shim
    ;;
  uninstall)
    require_root
    uninstall_shim
    ;;
  status)
    status_shim
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
