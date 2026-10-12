#!/usr/bin/env bash
#
# TensorMesh installer.
#
# Intended for a clean Linux GPU server. Run as a normal user (not root):
# the script uses sudo for the few privileged operations (writing to /etc,
# installing systemd units, creating the /usr/local/bin/tmesh symlink).
#
# Typical use:
#   ./install.sh
#   ./install.sh --web-url http://gpu-node:8000 --api-port 4317
#   ./install.sh --skip-services          # just build + write config
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
# install.sh lives at the repository root.
REPO_ROOT="$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
HOST_SHORT="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo localhost)"
WEB_URL="http://${HOST_SHORT}:8000"
DB_PATH="$REPO_ROOT/data/tensormesh.db"
WEB_PORT=8000
API_PORT=4317
ETC_DIR="/etc/tensormesh"
SERVICE_USER="$(id -un 2>/dev/null || echo "$USER")"

SKIP_INSTALL=0
SKIP_BUILD=0
SKIP_DOCS=0
SKIP_SERVICES=0
FORCE=0

# systemd templates live here; overridable for testing / packaging.
TEMPLATE_DIR="${TENSORMESH_SYSTEMD_TEMPLATE_DIR:-$REPO_ROOT/scripts/systemd}"

usage() {
  cat <<EOF
TensorMesh installer

Usage: ./install.sh [options]

Options:
  --web-url URL        Public URL of the web UI (default: http://<hostname>:8000)
  --db-path PATH       SQLite database path (default: <repo>/data/tensormesh.db)
  --web-port N         Web UI port (default: 8000)
  --api-port N         API port (default: 4317)
  --etc-dir DIR        Config directory (default: /etc/tensormesh)
  --service-user USER  Linux user that runs the web service (default: current user)
  --skip-install       Skip 'npm ci'
  --skip-build         Skip all builds (docs + web)
  --skip-docs          Skip the docs build/sync, still build the web frontend
  --skip-services      Do not touch sudo/systemd; render units into build/systemd/
  --force              Overwrite an existing tensormesh.env (default: keep it)
  -h, --help           Show this help and exit

Environment:
  TENSORMESH_SYSTEMD_TEMPLATE_DIR  Override the systemd template directory
EOF
}

need_val() {
  # $1 = flag name, $2 = remaining arg count
  [[ "$2" -ge 2 ]] || die "$1 需要一个参数值（使用 --help 查看用法）"
}

# ---------------------------------------------------------------------------
# Argument parsing (no interactive prompts)
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-url)          need_val "$1" "$#"; WEB_URL="$2"; shift 2 ;;
    --db-path)          need_val "$1" "$#"; DB_PATH="$2"; shift 2 ;;
    --web-port)         need_val "$1" "$#"; WEB_PORT="$2"; shift 2 ;;
    --api-port)         need_val "$1" "$#"; API_PORT="$2"; shift 2 ;;
    --etc-dir)          need_val "$1" "$#"; ETC_DIR="$2"; shift 2 ;;
    --service-user)     need_val "$1" "$#"; SERVICE_USER="$2"; shift 2 ;;
    --skip-install)     SKIP_INSTALL=1; shift ;;
    --skip-build)       SKIP_BUILD=1; shift ;;
    --skip-docs)        SKIP_DOCS=1; shift ;;
    --skip-services)    SKIP_SERVICES=1; shift ;;
    --force)            FORCE=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "未知参数: $1（使用 --help 查看用法）" ;;
  esac
done

# ---------------------------------------------------------------------------
# Basic validation
# ---------------------------------------------------------------------------
case "$API_PORT" in ''|*[!0-9]*) die "--api-port 必须是数字: $API_PORT" ;; esac
case "$WEB_PORT" in ''|*[!0-9]*) die "--web-port 必须是数字: $WEB_PORT" ;; esac
[[ -n "$WEB_URL" ]] || die "--web-url 不能为空"
[[ -n "$ETC_DIR" ]] || die "--etc-dir 不能为空"
[[ -n "$SERVICE_USER" ]] || die "--service-user 不能为空"

if [[ "$(id -u)" -eq 0 ]]; then
  die "请不要以 root 运行本脚本；请用普通用户运行，脚本会在需要时调用 sudo。"
fi

ENV_FILE="$ETC_DIR/tensormesh.env"

# ===========================================================================
# Step 1: pre-flight checks
# ===========================================================================
step "1/6 预检"

command -v node >/dev/null 2>&1 || die "未找到 node；TensorMesh 需要 Node.js >= 22.5"
if ! node -e '
  var parts = process.versions.node.split(".").map(Number);
  var major = parts[0], minor = parts[1];
  process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
'; then
  die "Node.js 版本过低（当前 $(node -v)）；需要 >= 22.5"
fi
ok "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "未找到 npm；请随 Node.js 一起安装"
ok "npm $(npm -v 2>/dev/null || echo '(unknown)')"

# Optional tools: warn only, never abort.
for tool in python3 tmux nvidia-smi systemctl sqlite3; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "找到 $tool"
  else
    warn "未找到 ${tool}（部分功能可能受限）"
  fi
done

for tool in sinfo sbatch srun squeue scontrol scancel; do
  command -v "$tool" >/dev/null 2>&1 || warn "未找到 Slurm 命令 ${tool}（Slurm 相关功能将不可用）"
done

if [[ "$SKIP_SERVICES" -eq 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "未找到 sudo；systemd 安装需要 sudo。可改用 --skip-services。"
  if ! sudo -n true 2>/dev/null; then
    warn "sudo 需要密码；后续系统操作会提示输入。"
  fi
else
  info "已指定 --skip-services，跳过 sudo/systemd 检查。"
fi

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  info "尚未安装依赖（node_modules 不存在）"
fi
ok "仓库根目录: $REPO_ROOT"

# ===========================================================================
# Step 2: install dependencies
# ===========================================================================
step "2/6 安装依赖"
if [[ "$SKIP_INSTALL" -eq 1 ]]; then
  info "已跳过依赖安装（--skip-install）"
else
  info "运行 npm ci --no-audit --no-fund"
  ( cd "$REPO_ROOT" && npm ci --no-audit --no-fund )
  ok "依赖安装完成"
fi

# ===========================================================================
# Step 3: build docs + web
# ===========================================================================
step "3/6 构建"
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  info "已跳过全部构建（--skip-build）"
else
  if [[ "$SKIP_DOCS" -eq 1 ]]; then
    info "已跳过文档构建/同步（--skip-docs）"
  else
    info "构建文档并同步到 web（npm run deploy:docs:web）"
    ( cd "$REPO_ROOT" && npm run deploy:docs:web )
    ok "文档构建/同步完成"
  fi
  info "构建前端（npm run build:web）"
  ( cd "$REPO_ROOT" && npm run build:web )
  ok "前端构建完成"
fi

# ===========================================================================
# Step 4: write configuration
# ===========================================================================
step "4/6 写入配置"

build_env_content() {
  cat <<EOF
# TensorMesh runtime configuration
# Generated by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date).
# After editing, restart the services:
#   sudo systemctl restart tensormesh-api tensormesh-web

TENSORMESH_HOST=0.0.0.0
TENSORMESH_PORT=$API_PORT
TENSORMESH_WEB_PORT=$WEB_PORT
TENSORMESH_WEB_URL=$WEB_URL
TENSORMESH_DB_PATH=$DB_PATH
TENSORMESH_COLLECT_INTERVAL_MS=10000
TENSORMESH_DEFAULT_CPUS_PER_GPU=4
TENSORMESH_DEFAULT_MEM_PER_GPU=24G

# --- Optional: email notifications (CloudMail) ---
# TENSORMESH_CLOUDMAIL_ENDPOINT=https://mail.example.com/external/api/send_mail
# TENSORMESH_CLOUDMAIL_TOKEN_FILE=$ETC_DIR/cloudmail.jwt
# TENSORMESH_MAIL_FROM_NAME=TensorMesh

# --- Optional: web proxy registry (path prefix -> upstream) ---
# TENSORMESH_WEB_PROXY_REGISTRY=/my_service=http://127.0.0.1:9001
EOF
}

if [[ -e "$ENV_FILE" && "$FORCE" -ne 1 ]]; then
  warn "配置文件已存在，保留不覆盖: $ENV_FILE"
  info "如需覆盖请重新运行并加上 --force"
else
  if [[ -d "$ETC_DIR" && -w "$ETC_DIR" ]]; then
    build_env_content > "$ENV_FILE"
    chmod 0644 "$ENV_FILE" 2>/dev/null || true
  elif mkdir -p "$ETC_DIR" 2>/dev/null; then
    build_env_content > "$ENV_FILE"
    chmod 0644 "$ENV_FILE" 2>/dev/null || true
  else
    info "创建 $ETC_DIR 需要 root 权限，使用 sudo"
    sudo install -d -m 0755 "$ETC_DIR"
    build_env_content | sudo tee "$ENV_FILE" >/dev/null
    sudo chmod 0644 "$ENV_FILE"
  fi
  ok "已写入 $ENV_FILE"
fi

info "配置文件: $ENV_FILE"
info "  TENSORMESH_HOST=0.0.0.0"
info "  TENSORMESH_PORT=$API_PORT"
info "  TENSORMESH_WEB_PORT=$WEB_PORT"
info "  TENSORMESH_WEB_URL=$WEB_URL"
info "  TENSORMESH_DB_PATH=$DB_PATH"

# ===========================================================================
# Step 5: systemd services (unless --skip-services)
# ===========================================================================
step "5/6 服务"

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
NODE_BIN_DIR="$(dirname -- "$NODE_BIN")"

API_UNIT="tensormesh-api.service"
WEB_UNIT="tensormesh-web.service"
ISO_UNIT="tensormesh-gpu-isolation.service"

render_one() {
  # $1 = template path, $2 = output path
  local template="$1" out="$2" content
  [[ -f "$template" ]] || die "缺少服务模板: $template"
  content="$(cat "$template")"
  content="${content//__REPO_ROOT__/$REPO_ROOT}"
  content="${content//__NODE_BIN_DIR__/$NODE_BIN_DIR}"
  content="${content//__NPM_BIN__/$NPM_BIN}"
  content="${content//__SERVICE_USER__/$SERVICE_USER}"
  content="${content//__ISOLATION_USER__/$SERVICE_USER}"
  if printf '%s' "$content" | grep -q '__'; then
    die "渲染 $out 后仍存在遗留占位符；请检查模板 ${template}（含未知的 __PLACEHOLDER__）"
  fi
  printf '%s\n' "$content" > "$out"
  chmod 0644 "$out" 2>/dev/null || true
}

find_isolation_template() {
  local candidate="$TEMPLATE_DIR/tensormesh-gpu-isolation.service"
  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

RENDER_DIR="$REPO_ROOT/build/systemd"
mkdir -p "$RENDER_DIR"
render_one "$TEMPLATE_DIR/$API_UNIT" "$RENDER_DIR/$API_UNIT"
render_one "$TEMPLATE_DIR/$WEB_UNIT" "$RENDER_DIR/$WEB_UNIT"
ISO_TEMPLATE=""
if ISO_TEMPLATE="$(find_isolation_template)"; then
  render_one "$ISO_TEMPLATE" "$RENDER_DIR/$ISO_UNIT"
else
  warn "未找到 GPU 隔离服务模板，跳过（可选组件）"
fi
ok "已渲染服务单元到 $RENDER_DIR"

if [[ "$SKIP_SERVICES" -eq 1 ]]; then
  info "已指定 --skip-services，未修改系统。手动安装步骤："
  printf '  sudo install -m 0644 %s/build/systemd/%s /etc/systemd/system/%s\n' "$REPO_ROOT" "$API_UNIT" "$API_UNIT"
  printf '  sudo install -m 0644 %s/build/systemd/%s /etc/systemd/system/%s\n' "$REPO_ROOT" "$WEB_UNIT" "$WEB_UNIT"
  if [[ -n "$ISO_TEMPLATE" ]]; then
    printf '  sudo install -m 0644 %s/build/systemd/%s /etc/systemd/system/%s   # 可选\n' "$REPO_ROOT" "$ISO_UNIT" "$ISO_UNIT"
  fi
  printf '  sudo systemctl daemon-reload\n'
  printf '  sudo systemctl enable --now tensormesh-api tensormesh-web\n'
  printf '  sudo ln -sfn %s/bin/tmesh /usr/local/bin/tmesh\n' "$REPO_ROOT"
else
  info "安装服务单元到 /etc/systemd/system/"
  sudo install -m 0644 "$RENDER_DIR/$API_UNIT" "/etc/systemd/system/$API_UNIT"
  sudo install -m 0644 "$RENDER_DIR/$WEB_UNIT" "/etc/systemd/system/$WEB_UNIT"
  if [[ -n "$ISO_TEMPLATE" ]]; then
    # Installed but not enabled: it is an optional admin component.
    sudo install -m 0644 "$RENDER_DIR/$ISO_UNIT" "/etc/systemd/system/$ISO_UNIT"
  fi
  ok "服务单元已安装"

  info "systemctl daemon-reload"
  sudo systemctl daemon-reload

  info "启用并启动 tensormesh-api tensormesh-web"
  sudo systemctl enable --now tensormesh-api tensormesh-web
  ok "服务已启用并启动"

  info "创建 /usr/local/bin/tmesh 符号链接"
  sudo ln -sfn "$REPO_ROOT/bin/tmesh" /usr/local/bin/tmesh
  ok "tmesh 命令已链接"
fi

# ===========================================================================
# Step 6: self-check
# ===========================================================================
step "6/6 自检"

check_url() {
  # $1 = url, $2 = label
  local url="$1" label="$2" i
  for i in $(seq 1 10); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then
      ok "$label 可访问: $url"
      return 0
    fi
    sleep 1
  done
  warn "$label 暂不可访问（已重试 10 次）: $url"
  return 0
}

if [[ "$SKIP_SERVICES" -eq 1 ]]; then
  info "已指定 --skip-services，跳过 HTTP 自检。"
else
  if command -v curl >/dev/null 2>&1; then
    check_url "http://127.0.0.1:${API_PORT}/health" "API"
    check_url "http://127.0.0.1:${WEB_PORT}/" "Web"
  else
    warn "未找到 curl，跳过 HTTP 自检。可手动检查: http://127.0.0.1:${API_PORT}/health"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
step "安装完成"

printf '%s\n' "${C_BOLD}访问地址${C_RESET}"
printf '  Web UI : %s\n' "$WEB_URL"
printf '  文档   : %s/doc/\n' "${WEB_URL%/}"
printf '  本地API: http://127.0.0.1:%s/health\n' "$API_PORT"

printf '\n%s\n' "${C_BOLD}常用命令${C_RESET}"
printf '  tmesh status\n'
printf '  tmesh web\n'

printf '\n%s\n' "${C_BOLD}配置文件${C_RESET}"
printf '  %s\n' "$ENV_FILE"

printf '\n%s\n' "${C_BOLD}卸载${C_RESET}"
printf '  ./uninstall.sh            # 保留配置与数据库\n'
printf '  ./uninstall.sh --purge    # 同时删除配置文件\n'

printf '\n%s\n' "${C_BOLD}可选管理组件${C_RESET}"
printf '  GPU 隔离（默认已安装未启用）、邮件通知、nvidia-smi shim：见文档说明。\n'

if [[ "$SKIP_SERVICES" -eq 1 ]]; then
  printf '\n'
  warn "本次为 --skip-services 干跑，未修改系统；请按上面的手动步骤启用服务。"
fi

exit 0
