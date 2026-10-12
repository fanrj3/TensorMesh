---
name: tensormesh
description: Use when working on the shared TensorMesh GPU server or when the user asks about tmesh, Slurm/GPU status, tmesh jobs, tmesh bash/tmux sessions, tmesh share (root parallel GPU sharing), TensorMesh Agent API, nvidia-smi through TensorMesh, Web/API docs, service proxy mounting behind port 8000, reminders, reservations, or TensorMesh operations.
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

Check jobs:

```bash
tmesh jobs --mine
tmesh job <jobid>
tmesh cancel <jobid>
```

## Share GPUs In Parallel (root only)

When all GPUs are occupied, root can borrow any card (including one already running another user's Slurm job) and run a task in parallel **without cancelling the original task**. The shared task runs outside Slurm in a root systemd scope and is hidden from TensorMesh status, so the card keeps showing the original user's task.

```bash
sudo tmesh share --gpu-indexes 0,1 --reason "short description" -- python eval.py
sudo tmesh share --gpu-indexes 6 --memory 8G --cpu-quota 50% -- python eval.py
sudo tmesh share --list
sudo tmesh share --cancel <id>
```

- `tmesh share` requires root: run it through `sudo`; the sudoers policy decides who may use it. Non-root invocations are rejected with a hint to use sudo.
- The shared task is hidden from `tmesh status` / Web / TUI (only the original user's task shows). `tmesh nvidia-smi` still shows real processes.
- Logs default to `<cwd>/.tmesh/shared/<id>.log`; task stdout also prints to the terminal while the command runs.
- Use `--memory` / `--cpu-quota` when borrowing a card that another user is actively using.

## Interactive Shells

Use `tmesh bash` for interactive GPU work:

```bash
tmesh bash --gpus 1 --time 4 --reason "debug training"
tmesh ls
tmesh open <ID>
tmesh close <ID>
```

TensorMesh bash sessions run in a dedicated tmux server. Multiple terminals can attach to one session with `tmesh open <ID>`. `tmesh ls` shows attached client count. `exit`, `logout`, `Ctrl-b d`, or SSH disconnect detach the current client; if the last client disconnects and the job was not `submit`ted, TensorMesh releases the Slurm job. Inside the tmux session, press `Esc` for the TensorMesh command prompt and middle-click for the tmux popup menu.

## Agent API For Bash Sessions

Use the HTTP API when an AI agent needs to observe or drive a `tmesh bash` session without attaching a terminal:

```http
GET /api/tmux/sessions
GET /api/tmux/sessions/<id>?lines=200&logBytes=65536
POST /api/tmux/sessions/<id>/input
```

Input example:

```json
{
  "input": "echo Hello_Tmesh",
  "enter": true,
  "literal": true
}
```

Use a signed TensorMesh web token for writes. The API restricts access to the token user's own TensorMesh tmux sessions. Prefer this API over manually scraping tmux when automating from an agent.

## Web And API

Generate a user-scoped Web URL:

```bash
tmesh web
tmesh web --ttl 24
```

Default endpoints:

```text
TensorMesh Web: http://<server>:8000/
Docs:           http://<server>:8000/doc/
API:            http://127.0.0.1:4317
```

Useful API routes:

```http
GET /api/status
GET /api/slurm
GET /api/nvidia-smi?arg=-L
GET /api/jobs/<jobid>/log?maxBytes=65536
GET /api/users/<user>/usage?days=14
```

## Temporary File Upload

Open a directory for token-protected uploads without taking over port 8000:

```bash
tmesh upload ~/uploads
tmesh upload /data/alice/inbox --ttl 2
```

The default lifetime is 6 hours and the maximum is 168 hours. The command prints a session-specific URL and random upload-only token. Users may also open `http://server:8000/upload` and paste that token; the Web gateway resolves its session automatically. The per-user backend writes as the invoking Linux user and exits automatically at expiry.

## Mount Local Services Behind 8000

TensorMesh Web supports a prefix proxy registry. To expose a local service through port 8000, add a registry entry and restart `tensormesh-web`.

Example:

```bash
TENSORMESH_WEB_PROXY_REGISTRY=/my_service=http://127.0.0.1:9001
sudo systemctl restart tensormesh-web
```

Then:

```text
http://server:8000/my_service
```

proxies to:

```text
http://127.0.0.1:9001/my_service
```

If the backend only serves root paths, use JSON with `"rewritePrefix":""`.

## Documentation Locations

When answering TensorMesh questions, check local docs first:

```text
/opt/tensormesh/apps/docs/docs/user-guide/cli.md
/opt/tensormesh/apps/docs/docs/reference/api.md
/opt/tensormesh/apps/docs/docs/reference/commands.md
/opt/tensormesh/apps/docs/docs/admin-guide/services.md
/opt/tensormesh/apps/docs/docs/getting-started/quickstart.md
/opt/tensormesh/apps/docs/docs/reference/feature-status.md
```

After editing docs, run:

```bash
npm run deploy:docs:web
```

## Safety Notes

Do not bypass TensorMesh/Slurm for GPU jobs unless the user explicitly asks. Do not cancel another user's Slurm job. Prefer `tmesh jobs --mine` for user-specific checks and `tmesh status --all` only when global context is needed. Use `sudo` only when modifying system service config or restarting TensorMesh services, and explain why.
