---
title: 配置参考
---

# 配置参考

## API 和 Web

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_HOST` | `0.0.0.0` | API 监听地址 |
| `TENSORMESH_PORT` | `4317` | API 监听端口 |
| `PORT` | 无 | API 端口兜底变量 |
| `TENSORMESH_WEB_PORT` | `8000` | Web 服务端口，也用于 `tmesh web` 推导 URL |
| `TENSORMESH_WEB_URL` | `http://<host>:8000` | `tmesh web` 输出的 Web base URL |
| `TENSORMESH_WEB_PROXY_REGISTRY` | 未设置 | Web 前缀代理注册表，支持 JSON 或 `prefix=target` 行，例如 `/my_service=http://127.0.0.1:9001` |
| `TENSORMESH_WEB_PROXY_REGISTRY_FILE` | 未设置 | Web 前缀代理注册表文件路径，格式同 `TENSORMESH_WEB_PROXY_REGISTRY` |
| `TENSORMESH_API` | `http://localhost:4317` | CLI 访问 API 的 base URL |
| `TENSORMESH_COLLECT_INTERVAL_MS` | `10000` | API 采集间隔 |
| `TENSORMESH_NVIDIA_SMI_TIMEOUT_MS` | `15000` | 单次 `nvidia-smi` 采集超时；用于容忍重启后首次 NVML 初始化较慢的情况 |
| `TENSORMESH_SERVER_NAME` | `hostname` | API 返回的服务器名 |
| `TENSORMESH_MOCK` | 未设置 | 设为 `1` 时 API 返回 mock GPU 数据 |
| `TENSORMESH_UPLOAD_MAX_BYTES` | `53687091200` | `tmesh upload` 单文件大小上限，默认 50 GiB |

## 数据库

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_DB_PATH` | `data/tensormesh.db` | SQLite 数据库路径 |
| `TENSORMESH_JOB_HISTORY_RETENTION_DAYS` | `240` | 已结束 Slurm job 历史保留天数；active job 不会被清理 |

API 会写入：

- GPU 采样历史。
- Slurm job 历史。
- 手动登记任务和预约。
- 用户提醒设置。
- 通知发送记录。
- 本地代码提醒队列和配额。

GPU 历史采样默认保留 14 天。Slurm job 历史默认保留 240 天。

## Slurm 提交默认值

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_DEFAULT_CPUS_PER_GPU` | `4` | `tmesh run` / `tmesh bash` 默认每张 GPU 的 CPU 核数 |
| `TENSORMESH_DEFAULT_MEM_PER_GPU` | `24G` | 默认每张 GPU 的内存额度 |
| `TENSORMESH_CANCEL_MARKER_DIR` | `tmp/cancelled-jobs` | 被取消 job 的本地标记目录 |

## Slurm 配置生成

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_SLURM_HOST` | `hostname -s` | 生成 `SlurmctldHost` 和 `NodeName` |
| `TENSORMESH_SLURM_GPU_COUNT` | `8` | typed GRES GPU 数 |
| `TENSORMESH_SLURM_THREADS_PER_CORE` | `2` | CPU 拓扑 |
| `TENSORMESH_SLURM_SOCKETS` | `2` | CPU 拓扑 |

## 邮件

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_CLOUDMAIL_ENDPOINT` | 未设置 | 邮件 API，例如 `https://mail.example.com/external/api/send_mail` |
| `TENSORMESH_CLOUDMAIL_TOKEN` | 未设置 | 邮件 API token，优先级高于文件 |
| `TENSORMESH_CLOUDMAIL_TOKEN_FILE` | `/etc/tensormesh/cloudmail.jwt` | 邮件 API token 文件 |
| `TENSORMESH_MAIL_FROM_NAME` | `TensorMesh` | 邮件发件显示名 |

邮件提醒默认关闭：只有同时设置 `TENSORMESH_CLOUDMAIL_ENDPOINT` 和 token（`TENSORMESH_CLOUDMAIL_TOKEN` 或 `TENSORMESH_CLOUDMAIL_TOKEN_FILE` 指向的 token 文件）才会启用。未配置时邮件提醒禁用，其余功能不受影响。

## wrapper

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TENSORMESH_NODE` | 自动探测 | `bin/tmesh` 使用的 Node.js 可执行文件 |
| `TENSORMESH_NOTICE_TOKEN` | 无 | 用户代码调用 `/api/local-notice` 的 Bearer token |
| `TENSORMESH_BASH_TMUX` | 未设置 | 设为 `0` 时禁用 `tmesh bash` 的 tmux 包装器 |
| `TENSORMESH_TMUX_SOCKET` | `tensormesh-<uid>` | TensorMesh 专用 tmux socket 名；API 按 token 用户 uid 映射到对应 tmux 目录 |
| `TENSORMESH_TMUX_SOCKET_PATH` | 未设置 | 显式指定 tmux socket 文件路径，优先级高于 `TENSORMESH_TMUX_SOCKET` |
| `TENSORMESH_TMUX_RELEASE_ON_DETACH` | 未设置 | 设为 `0` 时恢复 detach 后保留未 submit 会话的旧行为 |
| `TENSORMESH_SRUN` | `srun` | 覆盖交互 shell 使用的 Slurm `srun` 命令 |

## 登录层隔离

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TMESH_LOGIN_NODE_FILE` | `/etc/tensormesh/login-node-policy` | PAM hook 判断是否启用整机登录层策略 |
| `TMESH_LOGIN_CPU_POLICY` | `off` | 默认不限制登录层 CPU；设为 `shared` 才启用共享 CPU quota |
| `TMESH_LOGIN_CPU_CORES` | `4` | `shared` 模式下的共享 CPU 核数 |
