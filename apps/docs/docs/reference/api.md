---
title: HTTP API
---

# HTTP API

API 默认地址：

```text
http://localhost:4317
```

除 `/health` 和 `/tokens` 外，`/api/*` 都需要会话。会话 token 支持：

- `Authorization: Bearer <token>`
- `?token=<token>`
- `?t=<token>`
- `/tokens?<token>` 裸 query 入口会重定向到规范 URL。

本机 loopback 请求在非 Web proxy 场景下可按本地用户访问；远程浏览器应使用 `tmesh web` 生成 token。

## 系统接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查、采集间隔和数据库信息 |
| `GET` | `/api/session` | 当前 token 用户、过期时间、提醒设置和邮件配置 |
| `GET` | `/api/status` | 服务器、CPU、GPU、任务、预约和 Slurm 状态 |
| `GET` | `/api/slurm` | Slurm 节点和 job 状态 |
| `GET` | `/api/nvidia-smi?arg=-L` | 在系统服务层执行原始 `nvidia-smi` 只读查询 |
| `GET` | `/api/gpus` | GPU 列表 |
| `GET` | `/api/users` | 已知用户列表 |
| `GET` | `/api/tasks` | 当前任务列表 |
| `GET` | `/api/reservations` | 当前预约列表 |
| `GET` | `/api/shared-tasks` | 当前共享（借用）任务列表 |
| `POST` | `/api/shared-tasks` | 登记一个共享任务（body: `id`、`gpuIndexes`、`scope`、`command`） |
| `DELETE` | `/api/shared-tasks/<id>` | 注销一个共享任务 |

`/api/nvidia-smi` 返回 `command`、`stdout`、`stderr` 和 `exitCode`。多个参数用多个 `arg` 查询参数传入，例如：

```http
GET /api/nvidia-smi?arg=--query-gpu=index,name,memory.used&arg=--format=csv
```

服务端只允许只读查询参数，避免通过 API 修改 GPU 设置。CLI 的 `tmesh nvidia-smi` 默认使用这个接口，API 不可用时回退到当前 shell 的本地 `nvidia-smi`。

## 历史和统计

```http
GET /api/gpus/0/history?from=2026-05-30T00:00:00Z&to=2026-05-30T12:00:00Z&bucketSeconds=60&limit=1200
```

参数：

| 参数 | 说明 |
| --- | --- |
| `days` | 回看天数，范围约束为 1 小时到 14 天 |
| `from` / `to` | ISO 时间范围 |
| `bucketSeconds` | 聚合粒度，范围 10 秒到 1 天 |
| `limit` | 返回点数，范围 24 到 5000 |

用户卡时：

```http
GET /api/users/<user>/usage?days=14
```

Job 历史：

```http
GET /api/jobs/history?days=14&limit=50
```

`/api/jobs/history` 返回当前 token 用户自己的 Slurm job 历史。历史来自服务端采集循环写入的 SQLite 快照，因此从 API 部署并采集后开始可回溯；参数支持 `days`、`limit` 和 `active=1|0`。

服务端会在 job 离开 `squeue` 时尝试通过 Slurm controller 补齐 `COMPLETED`、`FAILED`、`CANCELLED` 等最终状态和时间。如果最终记录已被 controller 清理，则使用合成状态 `ENDED`，只表示 job 已离开当前队列，不代表成功完成。

## Job 操作

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/jobs/history?days=14&limit=50` | 读取当前 token 用户自己的 job 历史 |
| `POST` | `/api/jobs/<jobid>/cancel` | 取消 job，仅允许 job owner |
| `GET` | `/api/jobs/<jobid>/log?maxBytes=65536` | 读取 job 日志尾部，仅允许 job owner |

日志路径只允许读取 job 工作目录下的 TensorMesh 托管日志，避免任意文件读取。当前支持：

```text
.tmesh/<JOB_ID>/run.log
.tmesh/<JOB_ID>/bash.log
.tmesh/<JOB_ID>/submit.log
```

## 交互 shell Agent API

这些接口面向 Codex 这类 agent：不 attach 终端，也能读取 `tmesh bash` 的 tmux session 状态、当前屏幕、日志尾部，并向原始 shell pane 注入输入。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/tmux/sessions` | 列出当前 token 用户的 TensorMesh tmux session |
| `GET` | `/api/tmux/sessions/<id>?lines=200&logBytes=65536` | 读取 session 元数据、pane 状态、屏幕内容和 `bash.log` 尾部 |
| `POST` | `/api/tmux/sessions/<id>/input` | 向原始 shell pane 发送输入，仅允许 signed token |

发送输入示例：

```http
POST /api/tmux/sessions/123/input
Authorization: Bearer <signed-token>
Content-Type: application/json

{
  "input": "python train.py --config configs/debug.yaml",
  "enter": true,
  "literal": true
}
```

`enter` 默认 `true`，表示发送文本后追加回车执行；设为 `false` 时只把文本插入终端。`literal` 默认 `true`，按普通文本发送，不解释 tmux key name。输入最大 16 KiB。

访问控制按 TensorMesh web token 用户和 session owner 元数据校验；旧 session 没有 owner 元数据时会退回 Slurm job owner 校验，尚未分配出 job id 的旧 session 不允许通过 API 访问。默认 tmux socket 是每个 Linux 用户独立的 `/tmp/tmux-<uid>/tensormesh-<uid>`；如果 API 服务以 root 运行，也会按 token 用户 uid 定位该 socket。`TENSORMESH_TMUX_SOCKET` 可覆盖 socket 文件名，`TENSORMESH_TMUX_SOCKET_PATH` 可显式指定完整 socket 路径。

## 个人设置和提醒

更新提醒设置：

```http
PATCH /api/session/settings
Content-Type: application/json

{
  "reminderEmail": "user@example.com",
  "noticeMode": "explicit",
  "notifyJobFinished": true,
  "notifyReservationStarted": true,
  "notifyJobOverdue": true,
  "notifyLowGpu": false,
  "lowGpuMinutes": 30,
  "lowGpuThreshold": 50
}
```

发送测试邮件：

```http
POST /api/session/test-mail
Content-Type: application/json

{"toMail": "user@example.com"}
```

本地代码提醒：

```http
POST /api/local-notice
Authorization: Bearer <signed-token>
Content-Type: application/json

{
  "title": "Metric reached",
  "content": "r1=0.721 exceeded threshold=0.700",
  "logTail": "optional log tail text"
}
```

`/api/local-notice` 返回 `200` 表示立即发送成功；如果用户 30 分钟配额已用完，会返回排队状态，服务端稍后汇总发送。

## 手动登记和预约 API

这些接口已经实现，但当前推荐用户提交路径仍是 CLI/Slurm。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/tasks/register` | 登记当前用卡任务，写入 SQLite |
| `POST` | `/api/tasks/<taskid>/finish` | 标记登记任务完成 |
| `POST` | `/api/reservations` | 保存预约记录，默认不自动执行 |

登记任务必须包含 `project`、`content`、`command` 和 `gpuIndexes`。

预约必须包含 `project`、`content`、`command`、`workingDirectory`、`requestedStartAt`、`expiresAt` 和 `gpuIndexes`。

## 导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/export/current.csv` | 当前 Slurm job 表 CSV |
| `GET` | `/api/export/current.html` | 当前 Slurm job 表 HTML |
| `GET` | `/api/export/midnight.csv` | 过去 14 天 0 点快照 CSV |
| `GET` | `/api/export/midnight.html` | 过去 14 天 0 点快照 HTML |
