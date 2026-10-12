#!/usr/bin/env bash
# TensorMesh nvidia-smi notice shim.
#
# GPU-isolated login shells fail with a cryptic "Failed to initialize NVML"
# error, which makes new users think the server has no GPUs. This shim keeps
# the real behaviour whenever GPUs are actually usable (root, Slurm jobs,
# users without isolation) and otherwise prints a short onboarding notice.
#
# Install / uninstall:
#   sudo scripts/nvidia-smi/tensormesh-nvidia-smi-admin.sh install
#   sudo scripts/nvidia-smi/tensormesh-nvidia-smi-admin.sh uninstall
# Bypass the notice:
#   TENSORMESH_NVIDIA_SMI_NOTICE=off nvidia-smi
# Override the real binary (testing):
#   TMESH_NVIDIA_SMI_REAL=/path/to/nvidia-smi nvidia-smi
set -u

REAL_NVIDIA_SMI="${TMESH_NVIDIA_SMI_REAL:-/usr/bin/nvidia-smi}"

# Root always talks to the real binary (TensorMesh API and collectors run
# outside the login isolation and must keep working).
if [ "$(id -u)" -eq 0 ]; then
  exec "${REAL_NVIDIA_SMI}" "$@"
fi

# Explicit bypass for users who want the raw output.
case "${TENSORMESH_NVIDIA_SMI_NOTICE:-}" in
  off | 0 | false | no) exec "${REAL_NVIDIA_SMI}" "$@" ;;
esac

# Help does not need a GPU: pass it through unchanged.
for arg in "$@"; do
  case "${arg}" in
    -h | --help) exec "${REAL_NVIDIA_SMI}" "$@" ;;
  esac
done

# GPUs visible (inside a Slurm job, isolation disabled, ...): real behaviour.
if "${REAL_NVIDIA_SMI}" --query-gpu=index --format=csv,noheader >/dev/null 2>&1; then
  exec "${REAL_NVIDIA_SMI}" "$@"
fi

# GPU-isolated login shell: explain how to request resources.
WEB_URL="${TENSORMESH_WEB_URL:-}"
if [ -z "${WEB_URL}" ] && [ -r /etc/tensormesh/tensormesh.env ]; then
  WEB_URL="$(sed -n 's/^TENSORMESH_WEB_URL=//p' /etc/tensormesh/tensormesh.env | tail -n 1)"
fi

cat >&2 <<'EOF'

==================== TensorMesh 提示 ====================
这台服务器有 GPU，但普通登录环境默认看不到显卡（避免互相抢卡），
所以直接运行 nvidia-smi 会报错。请通过 TensorMesh 申请后使用：

  查看资源   tmesh status                       GPU / 队列总览
  查看任务   tmesh jobs                         当前所有任务
  申请运行   tmesh run --gpus 1 -- nvidia-smi   申请 1 张卡运行命令
  交互 shell tmesh bash --gpus 1                申请 1 张卡进入终端
  真实状态   watch -n 2 tmesh nvidia-smi         查看显卡实时状态

任务拿到 GPU 后，卡内可直接使用 nvidia-smi 和训练脚本。
This login shell is GPU-isolated; use `tmesh` above to view/request GPUs.
绕过本提示：TENSORMESH_NVIDIA_SMI_NOTICE=off nvidia-smi
EOF

if [ -n "${WEB_URL}" ]; then
  printf '文档入口：%s/doc\n' "${WEB_URL%/}" >&2
fi
echo "=========================================================" >&2
exit 255
