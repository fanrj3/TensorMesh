---
title: AI Agent Skill
---

# AI Agent Skill

TensorMesh 提供一个 Codex Skill，让 AI agent 在需要使用共享 GPU 服务器时自动理解 `tmesh` 的常用命令、交互 shell、Agent API、`nvidia-smi`、Web 代理注册表和文档位置。

Skill 公共路径：

```text
/opt/tensormesh/skills/tensormesh
```

Skill 文件：

```text
/opt/tensormesh/skills/tensormesh/SKILL.md
```

<a className="button button--primary" href="/doc/skills/tensormesh/SKILL.md" download>下载 TensorMesh Skill 文件</a>

## 方式一：复制代码块创建 Skill

在 Codex 的 skills 目录里创建：

```bash
mkdir -p ~/.codex/skills/tensormesh
nano ~/.codex/skills/tensormesh/SKILL.md
```

然后复制下面内容保存：

````markdown
---
name: tensormesh
description: Use when working on the shared TensorMesh GPU server or when the user asks about tmesh, Slurm/GPU status, tmesh jobs, tmesh bash/tmux sessions, TensorMesh Agent API, nvidia-smi through TensorMesh, Web/API docs, service proxy mounting behind port 8000, reminders, reservations, or TensorMesh operations.
---

# TensorMesh

Use TensorMesh as the source of truth for GPU/Slurm state on this server. Prefer `tmesh` and the TensorMesh HTTP API over direct GPU probing unless the task explicitly requires raw system commands.

## Quick Commands

```bash
tmesh status
tmesh status --all
tmesh jobs
tmesh jobs --mine
tmesh job <jobid>
tmesh gpu <index>
tmesh nvidia-smi
watch -n 2 tmesh nvidia-smi
```

`tmesh nvidia-smi` returns raw system-level `nvidia-smi` output through `tensormesh-api` when available, so it still works when ordinary login shells are GPU-isolated. Use `tmesh nvidia-smi -L` for the device list. Use `--json` when a script or agent needs structured `stdout`, `stderr`, and `exitCode`.

## Submit And Inspect Jobs

Submit batch work through Slurm:

```bash
tmesh run --gpus 1 --time 2 --reason "short description" -- python train.py
tmesh run --gpu-indexes 0,1 --time 8 --reason "two GPU run" -- bash train.sh
```

Use `--reason` with a concise human-readable task description. Use `--notice` only when the user wants configured completion reminders.

## Interactive Shells

Use `tmesh bash` for interactive GPU work:

```bash
tmesh bash --gpus 1 --time 4 --reason "debug training"
tmesh ls
tmesh open <ID>
tmesh close <ID>
```

Multiple terminals can attach to one TensorMesh tmux session. `exit`, `logout`, `Ctrl-b d`, or SSH disconnect detach the current client; if the last client disconnects and the job was not `submit`ted, TensorMesh releases the Slurm job.

## Agent API

```http
GET /api/tmux/sessions
GET /api/tmux/sessions/<id>?lines=200&logBytes=65536
POST /api/tmux/sessions/<id>/input
```

Use a signed TensorMesh web token for writes. Prefer this API when automating a `tmesh bash` session from an agent.

## Web Proxy

Expose a local service behind 8000:

```bash
TENSORMESH_WEB_PROXY_REGISTRY=/my_service=http://127.0.0.1:9001
sudo systemctl restart tensormesh-web
```

Then `http://server:8000/my_service` proxies to `http://127.0.0.1:9001/my_service`.

## Docs

Check local docs first:

```text
/opt/tensormesh/apps/docs/docs/user-guide/cli.md
/opt/tensormesh/apps/docs/docs/reference/api.md
/opt/tensormesh/apps/docs/docs/reference/commands.md
/opt/tensormesh/apps/docs/docs/admin-guide/services.md
/opt/tensormesh/apps/docs/docs/getting-started/quickstart.md
/opt/tensormesh/apps/docs/docs/reference/feature-status.md
```
````

## 方式二：下载 Skill 文档

点击上面的下载链接保存 `SKILL.md`。如果是在服务器本机，也可以用命令下载：

```bash
mkdir -p ~/.codex/skills/tensormesh
curl -fsSL 'http://127.0.0.1:8000/doc/skills/tensormesh/SKILL.md' \
  -o ~/.codex/skills/tensormesh/SKILL.md
```

## 方式三：让 Codex 从公共路径安装

同一台服务器上的所有用户都可以让 Codex 从这个公共路径复制安装：

```text
/opt/tensormesh/skills/tensormesh
```

把下面 prompt 直接发给 Codex：

```text
请安装 TensorMesh skill。源目录是 /opt/tensormesh/skills/tensormesh，请把它复制到我的 Codex skills 目录：

${CODEX_HOME:-$HOME/.codex}/skills/tensormesh

安装后请检查 SKILL.md 存在，并告诉我以后遇到 tmesh、TensorMesh、Slurm/GPU 状态、tmesh bash、Agent API、nvidia-smi 或 8000 端口服务代理相关问题时会自动使用这个 skill。
```

安装完成后，重新开启一个 Codex 会话或让 Codex 重新加载 skills，即可在相关任务中自动触发。
