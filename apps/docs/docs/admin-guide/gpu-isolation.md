---
title: GPU 登录隔离
---

# GPU 登录隔离

TensorMesh 提供两套 GPU 登录隔离脚本：

- 推荐路径：PAM session hook，对普通登录层 cgroup 应用 no-GPU devices 策略。
- 过渡路径：systemd daemon 持续搬运指定用户的非 Slurm 进程到 no-GPU cgroup。

目标是让普通 SSH、VS Code、tmux 登录 shell 默认看不到 GPU，用户必须通过 Slurm job 获得 GPU。

## PAM 登录层策略

管理员脚本：

```text
scripts/pam/tensormesh-no-gpu-admin.sh
```

安装 PAM hook：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh install
```

启用整个登录节点策略：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh enable-login-node
```

只启用某个用户：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh enable-user alice
```

查看策略：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh list
```

立即应用到当前登录层：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh apply-login-node
```

恢复当前登录层限制：

```bash
sudo scripts/pam/tensormesh-no-gpu-admin.sh restore-login-node
```

## CPU quota

当前默认不再给共享 `user.slice` 设置 CPU quota，只做 GPU devices deny。原因是常见的 cgroup v1 hybrid 部署下 CPU 控制器没有 per-user slice，若直接限制 `/sys/fs/cgroup/cpu,cpuacct/user.slice`，所有 SSH、VSCode、tmux 登录用户会共享同一个 CPU 池，终端交互会被后台进程拖慢。

如果后续确认要临时启用共享登录层 CPU quota，可以显式设置：

```text
TMESH_LOGIN_CPU_POLICY=shared
TMESH_LOGIN_CPU_CORES=4
```

Slurm 作业和 TensorMesh systemd 服务在兄弟 cgroup，不受普通登录 shell 的 devices 策略影响。

## 新用户提示：nvidia-smi 引导

隔离生效后，普通登录 shell 直接运行 `nvidia-smi` 只会看到
`Failed to initialize NVML: Unknown Error`，新用户容易误认为这台机器没有 GPU。
仓库提供一个提示脚本，安装后普通用户会收到一段中文引导（含 `tmesh status`、
`tmesh run`、`tmesh bash` 等示例）：

```bash
sudo scripts/nvidia-smi/tensormesh-nvidia-smi-admin.sh install
sudo scripts/nvidia-smi/tensormesh-nvidia-smi-admin.sh status
sudo scripts/nvidia-smi/tensormesh-nvidia-smi-admin.sh uninstall
```

行为说明：

- 安装位置为 `/usr/local/bin/nvidia-smi`，在默认 PATH 中先于 `/usr/bin/nvidia-smi`。
- root 和 Slurm 作业内（真实能访问 GPU 的进程）原样调用真实 `nvidia-smi`；API 采集与 `tmesh nvidia-smi` 走 root/API 路径，不受影响。
- 只有被隔离的用户会看到提示：内容输出到 stderr，stdout 保持为空、退出码 255，与真实失败语义一致，不破坏脚本解析。
- `-h` / `--help` 直接透传真实帮助。
- 提示中的文档入口取自 `/etc/tensormesh/tensormesh.env` 的 `TENSORMESH_WEB_URL`（未设置时不显示）。
- 用户可用 `TENSORMESH_NVIDIA_SMI_NOTICE=off nvidia-smi` 或 `/usr/bin/nvidia-smi` 绕过提示。

## 注意事项

- API 服务必须运行在隔离外，否则普通用户无法通过 Web/TUI 看到全局 GPU telemetry。
- 启用全局策略前先对单个用户试运行，确认 Slurm job 内的 GPU 可见性正常。
- PAM hook 会修改 `/etc/pam.d/common-session`，脚本会先创建带时间戳的备份。

## 过渡 daemon

过渡脚本与 systemd 单元模板：

```text
scripts/systemd/tensormesh-gpu-isolation.sh
scripts/systemd/tensormesh-gpu-isolation.service
```

它会把指定用户的非 Slurm 进程持续搬运到 no-GPU devices cgroup。systemd 模板中的 `__ISOLATION_USER__` 占位符由 `install.sh` 渲染为实际用户名。当前文档不建议把它作为长期方案，优先使用 PAM 登录层策略。
