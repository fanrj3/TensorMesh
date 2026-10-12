#!/usr/bin/env bash
#
# TensorMesh uninstaller.
#
# Stops and removes the systemd units and the /usr/local/bin/tmesh symlink.
# By default the configuration (/etc/tensormesh/tensormesh.env) and the
# database are preserved; pass --purge to also remove the config file.
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GRN=$'\033[32m'
  C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""; C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_BOLD=""
fi

info() { printf '%s\n' "${C_BLU}[info]${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GRN}[ ok ]${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YEL}[warn]${C_RESET} $*" >&2; }
err()  { printf '%s\n' "${C_RED}[fail]${C_RESET} $*" >&2; }
die()  { err "$*"; exit 1; }
step() { printf '\n%s\n' "${C_BOLD}==> $*${C_RESET}"; }

# ---------------------------------------------------------------------------
# Resolve REPO_ROOT (works from any cwd, follows symlinks)
# ---------------------------------------------------------------------------
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  LINK_TARGET="$(readlink "$SOURCE")"
  case "$LINK_TARGET" in
    /*) SOURCE="$LINK_TARGET" ;;
    *)  SOURCE="$LINK_DIR/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

ETC_DIR="/etc/tensormesh"
PURGE=0

usage() {
  cat <<EOF
TensorMesh uninstaller

Usage: ./uninstall.sh [options]

Options:
  --etc-dir DIR   Config directory (default: /etc/tensormesh)
  --purge         Also remove the config file (tensormesh.env)
  -h, --help      Show this help and exit
EOF
}

need_val() {
  [[ "$2" -ge 2 ]] || die "$1 需要一个参数值（使用 --help 查看用法）"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --etc-dir) need_val "$1" "$#"; ETC_DIR="$2"; shift 2 ;;
    --purge)   PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         die "未知参数: $1（使用 --help 查看用法）" ;;
  esac
done

ENV_FILE="$ETC_DIR/tensormesh.env"
SYSTEMD_DIR="/etc/systemd/system"
TMESH_LINK="/usr/local/bin/tmesh"

# Privilege escalation: use sudo unless we are already root.
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    if ! sudo -n true 2>/dev/null; then
      warn "sudo 需要密码；系统操作会提示输入。"
    fi
  else
    die "未找到 sudo；请以 root 运行或安装 sudo。"
  fi
fi

# Remove a file, escalating to sudo only when the current user cannot.
remove_file() {
  local path="$1"
  if [[ -w "$path" ]] || [[ -w "$(dirname "$path")" ]]; then
    rm -f "$path"
  else
    $SUDO rm -f "$path"
  fi
}

# ===========================================================================
# Step 1: stop + disable services
# ===========================================================================
step "1/4 停止并禁用服务"
if command -v systemctl >/dev/null 2>&1; then
  for unit in tensormesh-api tensormesh-web; do
    if systemctl list-unit-files "$unit.service" >/dev/null 2>&1; then
      $SUDO systemctl disable --now "$unit" >/dev/null 2>&1 || true
      info "已停止并禁用 $unit"
    else
      info "$unit 未安装，跳过"
    fi
  done
else
  warn "未找到 systemctl，跳过服务停止（非 systemd 环境？）"
fi

# ===========================================================================
# Step 2: remove unit files
# ===========================================================================
step "2/4 删除 systemd 单元文件"
REMOVED_UNITS=0
for unit in tensormesh-api.service tensormesh-web.service tensormesh-gpu-isolation.service; do
  if [[ -e "$SYSTEMD_DIR/$unit" ]]; then
    remove_file "$SYSTEMD_DIR/$unit"
    info "已删除 $SYSTEMD_DIR/$unit"
    REMOVED_UNITS=1
  else
    info "未找到 $SYSTEMD_DIR/${unit}，跳过"
  fi
done
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
  ok "已执行 systemctl daemon-reload"
fi

# ===========================================================================
# Step 3: remove tmesh symlink (only if it points into this repo)
# ===========================================================================
step "3/4 删除 tmesh 符号链接"
if [[ -L "$TMESH_LINK" ]]; then
  LINK_TARGET="$(readlink "$TMESH_LINK")"
  EXPECTED="$REPO_ROOT/bin/tmesh"
  if [[ "$LINK_TARGET" == "$EXPECTED" ]]; then
    remove_file "$TMESH_LINK"
    ok "已删除符号链接 $TMESH_LINK -> $EXPECTED"
  else
    warn "$TMESH_LINK 指向 ${LINK_TARGET}（并非本仓库），已保留。"
  fi
elif [[ -e "$TMESH_LINK" ]]; then
  warn "$TMESH_LINK 存在但不是符号链接，已保留。"
else
  info "$TMESH_LINK 不存在，跳过"
fi

# ===========================================================================
# Step 4: config / database
# ===========================================================================
step "4/4 配置文件与数据库"
if [[ "$PURGE" -eq 1 ]]; then
  if [[ -e "$ENV_FILE" ]]; then
    remove_file "$ENV_FILE"
    ok "已删除配置文件 $ENV_FILE"
  else
    info "$ENV_FILE 不存在，跳过"
  fi
else
  info "保留配置文件（--purge 可删除）"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
step "卸载完成"

printf '%s\n' "${C_BOLD}本次操作结果${C_RESET}"
if [[ "$PURGE" -eq 1 ]]; then
  printf '  配置文件 %s : 已删除\n' "$ENV_FILE"
else
  printf '  配置文件 %s : 保留\n' "$ENV_FILE"
fi
printf '  仓库目录 %s : 保留\n' "$REPO_ROOT"
printf '  数据库   : 保留（见配置中的 TENSORMESH_DB_PATH）\n'

if [[ "$REMOVED_UNITS" -eq 0 ]]; then
  printf '\n'
  warn "未发现任何 TensorMesh systemd 单元，可能本就未安装。"
fi

exit 0
