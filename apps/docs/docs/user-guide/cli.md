---
title: CLI 手册
---

# CLI 手册

`tmesh` 是普通用户的主入口。它沿用当前 Linux 用户身份，不需要单独登录；Web token、Slurm 提交、提醒设置和交互 shell 都从这个入口发起。

裸 `tmesh` 会进入全屏 TUI。需要一次性命令时使用 `tmesh <command>`。

## 命令总览

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `tmesh` | 打开 curses TUI | 当前默认入口 |
| `tmesh tui` | 打开 Node 简易 TUI | 备用入口，裸命令优先走 Python TUI |
| `tmesh status` | 查看 Slurm 节点、job 和 GPU 状态 | 默认只显示当前用户相关 Slurm job |
| `tmesh status --all` | 查看所有用户 Slurm job | 管理和排队判断常用 |
| `tmesh status --api` | 只看 API 返回的 GPU 状态 | API 不通时会回退 mock |
| `tmesh nvidia-smi` | 输出系统层面的原始 `nvidia-smi` | 支持 `watch tmesh nvidia-smi` |
| `tmesh gpu <index>` | 查看单张 GPU 详情 | 例如 `tmesh gpu 0` |
| `tmesh jobs` | 查看所有 Slurm job | 当前默认是全用户 |
| `tmesh jobs --mine` | 只看自己的 Slurm job | 用户自查 |
| `tmesh job <jobid>` | 查看单个 job 详情 | 包含 GRES、工作目录、命令和 Reason |
| `tmesh cancel <jobid>` | 取消 job | Slurm 权限决定是否允许 |
| `tmesh run ... -- COMMAND` | 提交后台 Slurm GPU 作业 | 日志写入 `.tmesh/<JOB_ID>/run.log` |
| `tmesh bash ...` | 打开交互式 Slurm GPU shell | 默认使用专用 tmux server |
| `tmesh ls` | 列出自己的 TensorMesh tmux 会话 | 显示 attach 客户端数量 |
| `tmesh open <ID>` | 连接 TensorMesh tmux 会话 | 可多个终端同时连接 |
| `tmesh close <ID>` | 关闭 TensorMesh tmux 会话 | 默认同时取消对应 Slurm job |
| `tmesh reserve ...` | 提交未来启动的 Slurm job | 基于 Slurm `--begin` |
| `tmesh bind ...` | 把已有外部 GPU 进程绑定成 Slurm 占位 job | 临时保护未通过 Slurm 启动的任务 |
| `tmesh share ...` | root 在已占用卡上并行跑任务，不取消原任务 | 需 `sudo tmesh share`（sudoers 决定谁能用），不经过 Slurm，状态页不显示共享任务 |
| `tmesh web` | 生成带 token 的 Web URL | 推荐从 SSH 终端发起 |
| `tmesh notice` | 查看或配置提醒 | 邮箱、选项、测试邮件、本地代码提醒 |
| `tmesh history` | 查看自己的 Slurm job 历史 | 优先 TensorMesh API/SQLite，必要时回退 `sacct` |
| `tmesh history --gpu <index>` | 查看 GPU 历史尾部 | 兼容旧用法 |
| `tmesh usage` | mock 卡时输出 | 真实卡时请用 Web/API |
| `tmesh help` | 打印当前 CLI help | 文档更新以此为准 |

全局输出参数：

| 参数 | 作用 |
| --- | --- |
| `--json` | 对 `status`、`jobs`、`job`、`gpu`、`usage`、`history`、`ls` 等查询命令输出 JSON，便于脚本解析 |
| `--plain` | 输出无 ANSI 颜色、无 Unicode 条形图的 ASCII 文本，适合保存日志或复制到不支持终端样式的系统 |
| `--no-color` | `--plain` 的别名 |

## 状态查看

常规自查：

```bash
tmesh status
tmesh jobs --mine
tmesh gpu 0
```

排队或协作时查看全局：

```bash
tmesh status --all
tmesh jobs
```

`status` 会先展示 Slurm 节点和 job，再展示 TensorMesh API 或本机 `nvidia-smi` 能拿到的 GPU 状态。登录层启用 no-GPU 后，普通 shell 可能无法直接调用 `nvidia-smi`；这时应依赖运行在隔离外的 API 服务。

需要查看原始 `nvidia-smi` 输出时：

```bash
tmesh nvidia-smi
watch -n 2 tmesh nvidia-smi
tmesh nvidia-smi -L
```

`tmesh nvidia-smi` 优先通过 `tensormesh-api` 在系统服务层执行，所以普通登录 shell 被 GPU 隔离时仍可看到全局视图；API 不可用时会回退到当前 shell 的本地 `nvidia-smi`。额外参数会传给 `nvidia-smi`，服务端只允许只读查询参数。

脚本化读取：

```bash
tmesh jobs --json
tmesh history --json
tmesh status --all --json
tmesh --json job 141
```

纯文本日志：

```bash
tmesh status --all --plain > status.txt
```

如果 CLI 访问 API 失败，会输出当前 API base URL 和建议检查命令。常见处理是确认 `tensormesh-api` 正在运行，或显式设置：

```bash
export TENSORMESH_API=http://127.0.0.1:4317
```

## 排队规则

`run`、`bash` 和 `reserve` 最终都进入 Slurm `gpu` 分区。默认部署按提交顺序确定优先级，并允许使用不冲突的空闲资源：

1. 有足够 GPU、CPU 和内存时，job 立即启动。
2. 资源不足时，job 保持 `PENDING` 并成为队列中的一项。
3. 调度器保护前序 job 的预计启动时间。
4. 后续 job 如果使用不同的空闲 GPU、CPU 和内存，且不会推迟前序 job，就可以回填运行。
5. 会推迟前序 job 的任务继续等待，运行中的任务也不会被抢占。

例如前序任务只等待 `gpu6` 或 `gpu7`，而 0–5 卡空闲时，后续 `--gpus 1` job 可以使用这些空闲卡。若前序任务等待 4 张任意 GPU，后续长任务会占用其中一张并推迟它，则后续任务仍会等待。

`--gpu-indexes 1,7` 必须等待指定卡同时可用；`--gpus 2` 可以使用任意两张空闲卡。是否能够回填还取决于 CPU、内存和 `--slurm-time`，可用 `tmesh jobs` 或 `tmesh status --all` 查看当前队列。

运行中的任务会显示 `KILL IN` / `Kill in`，它是根据 Slurm 硬限制计算的强制终止倒计时；`tmesh job <JOB_ID>` 还会显示完整的 `Hard limit` 和 `Kill at`。排队任务的硬限制从真正获得资源、开始运行后计时，因此会显示 `on start`，不会把排队时间误算进倒计时。

## Job 历史

当前队列只显示还在 Slurm 里的 job。需要回溯自己最近提交过的任务时：

```bash
tmesh history
tmesh history --days 30 --limit 100
tmesh history --finished
tmesh history --active
```

`history` 默认只看当前 Linux 用户。CLI 优先读取 `/api/jobs/history`；API 不可用时会尝试只读读取本地 TensorMesh SQLite；如果集群启用了 Slurm accounting，还会回退到 `sacct`。如果这些来源都没有数据，会明确提示对应来源不可用或暂无采集记录。

服务端会在 job 离开当前队列时尝试从 Slurm controller 补取最终状态。如果 controller 已经清理该 job 且 accounting 未启用，历史状态显示为 `ENDED`，表示“确认已离开队列，但无法判断成功、失败或取消”，不能把它等同于 `COMPLETED`。

## Reason 和预计时间

`run`、`bash`、`reserve` 都需要任务描述。交互终端中如果没有传 `--reason`，CLI 会提示：

```text
请描述当前任务(示例:盲道-大规模推理)：
```

输入 `exit` 或按 `Esc` 会取消创建。非交互场景必须显式传入：

```bash
--reason "MNIST smoke"
```

`--time` 是 TensorMesh 的预计时长，只用于展示预计结束、超时标红和提醒，不会自动杀任务。它按小时输入：

```text
0.5  表示 30 分钟
10   表示 10 小时
24   表示 24 小时
```

真正的 Slurm 硬时间限制由 `--slurm-time` 控制，默认是 `7-00:00:00`。

:::danger 重要：超过 7 天必须显式设置硬限制

<span className="tm-danger-text">默认 `--slurm-time` 是 7 天。任务运行到 7 天仍未结束时，Slurm 会自动终止该 job。</span>

如果预计任务会超过 7 天，必须在提交时显式传入更长的硬限制，例如：

```bash
tmesh run --gpus 1 --time 240 --slurm-time 14-00:00:00 --reason "两周长实验" -- python train.py
```

`--time 240` 仍只是 TensorMesh 的预计展示时间；真正防止 7 天后被杀的是 `--slurm-time 14-00:00:00`。

当前 `gpu` 分区接受不超过 90 天的硬限制，例如 `--slurm-time 31-00:00:00`；超过 90 天的请求会被 Slurm 拒绝。

:::

## 后台作业

最小示例：

```bash
tmesh run --gpus 1 --name smoke --time 0.2 --reason "GPU smoke" -- nvidia-smi
```

指定物理卡：

```bash
tmesh run --gpu-indexes 4,5 --name train_pair --time 8 --reason "双卡训练" -- python train.py
```

`--gpu 4` 是 `--gpu-indexes 4` 的别名。若指定的卡被占用，Slurm 会排队等待。

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--gpus N` | 必填，除非使用 `--gpu-indexes` | 申请 N 张任意 GPU |
| `--gpu-indexes 0,1` | 无 | 申请指定物理 GPU，对应 typed GRES |
| `--name NAME` | `tmesh-job` | Slurm job 名称 |
| `--time HOURS` | `24` | TensorMesh 预计时长 |
| `--slurm-time LIMIT` | `7-00:00:00` | Slurm 硬限制 |
| `--reason TEXT` | 交互提示 | 任务描述，写入 Slurm comment |
| `--cwd DIR` | 当前目录 | job 工作目录 |
| `--partition NAME` | `gpu` | Slurm 分区 |
| `--cpus-per-gpu N` | `4` | 每张 GPU 的 CPU 申请 |
| `--mem-per-gpu SIZE` | `24G` | 每张 GPU 的内存申请 |
| `--output PATH` | `.tmesh/%j/run.log` | 自定义 sbatch 输出 |
| `--notice` | 关闭 | 显式开启该 job 的邮件提醒 |

默认日志路径：

```text
.tmesh/<JOB_ID>/run.log
```

不需要在命令里手动 `cd`。`tmesh run` 默认以执行命令时的当前目录作为 Slurm 工作目录。

## 交互式 shell

打开一张卡：

```bash
tmesh bash --gpus 1 --name debug_mnist --time 10 --reason "MNIST 调试"
```

进入后提示符会带上 job ID，例如：

```text
[T137] alice@server:~$
```

tmux 底部状态栏会显示当前 job 的 `Kill in`，并每 10 秒从 Slurm 刷新一次。刚进入 shell 时打印的 job 信息也包含硬限制、剩余时间和预计强制终止时刻。

默认资源：

| 参数 | 默认值 |
| --- | --- |
| `--name` | `tmesh-bash` |
| `--time` | `24` 小时预计时长 |
| `--slurm-time` | `7-00:00:00` |
| `--cpus-per-gpu` | `4` |
| `--mem-per-gpu` | `24G` |
| `--partition` | `gpu` |

如果当前空闲 GPU 不足，`tmesh bash` 会先提示是否进入 tmux 终端等待 Slurm 排队。需要脚本化控制时使用：

```bash
tmesh bash --gpus 7 --wait
tmesh bash --gpus 7 --no-wait
```

### tmux 会话

交互 shell 默认跑在专用 tmux server：

```text
tensormesh-<uid>
```

它不会污染用户自己的普通 tmux 会话。相关命令：

```bash
tmesh ls
tmesh open <ID>
tmesh close <ID>
tmesh close <ID> --no-cancel
```

`tmesh open <ID>` 可以从多个终端同时连接到同一个 TensorMesh shell；`tmesh ls` 的状态会显示客户端数量，例如 `attached(2)`。输入 `exit`、按 `Ctrl-b d` 或 SSH 断开只会关闭当前客户端。如果这是最后一个客户端，并且没有执行过 `submit`，TensorMesh 会取消对应 Slurm job 并释放 tmux session。

`close` 默认会取消对应 Slurm job；加 `--no-cancel` 只关闭 tmux 会话。

日志路径：

```text
.tmesh/<JOB_ID>/bash.log
```

### 命令模式

在交互 shell 中按单独的 `Esc` 会打开 TensorMesh 命令面板；鼠标中键会打开原来的 tmux 弹出菜单。右键 tmux 菜单已禁用，避免和 VS Code 或其他终端的右键复制冲突。命令面板可用命令：

| 命令 | 作用 |
| --- | --- |
| `job` | 查看当前 Slurm job |
| `jobs` | 查看全局 Slurm job |
| `status` | 查看 TensorMesh 状态 |
| `log` | 追踪当前 `.tmesh/<JOB_ID>/bash.log` |
| `notice` | 打开提醒设置 |
| `notice on` | 为当前 job 开启提醒 |
| `notice off` | 为当前 job 关闭提醒 |
| `close` | 关闭当前终端连接 |
| `cancel` | 取消当前 Slurm job |
| `submit` | 在检测到真实工作进程后关闭当前连接，让任务继续后台运行 |
| `help` | 显示命令帮助 |

`submit` 不是简单 detach。它会检查当前 Slurm job 里是否有真实工作进程，而不是只有空 shell。确认后关闭客户端连接，tmux 会话和 Slurm job 继续运行；即使没有客户端连接也不会触发最后断开释放。训练结束后监控进程会让 shell 退出。

如果要退回旧的非 tmux PTY 包装器：

```bash
TENSORMESH_BASH_TMUX=0 tmesh bash --gpus 1 --reason "legacy debug"
```

旧包装器的 `submit` 会把后续输出写入 `.tmesh/<JOB_ID>/submit.log`。

## 预约和未来作业

预约本质是提交带 `--begin` 的 Slurm job：

```bash
tmesh reserve --at 23:00 --gpus 1 --name night_train --time 8 --reason "夜间训练" -- python train.py
```

支持的时间形式：

```text
23:00
2026-06-01T23:00
2026-06-01 23:00
```

如果不提供命令，TensorMesh 会提交一个启动后 `sleep infinity` 的占位 job：

```bash
tmesh reserve --at 23:00 --gpus 1 --reason "保留卡做调试"
```

这是 Slurm 队列层面的预约式用法；Web 里的“预约登记”是 SQLite 记录，默认不自动执行命令。

## 绑定已有外部 GPU 任务

如果有人已经在 GPU 上跑了非 Slurm 进程，短期内不能重启，可以用 `bind` 创建 Slurm 占位 job，避免别人申请到这些卡：

```bash
tmesh bind --gpu-indexes 0,1 --owner alice --name alice-existing --reason "已有推理任务保护"
```

可选参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--gpu-indexes IDS` | 必填 | 需要保护的物理 GPU |
| `--owner USER` | 当前用户 | 进程归属用户 |
| `--pids PID,PID` | 自动按 owner 和 GPU 推断 | 精确绑定进程列表 |
| `--poll SECONDS` | `30` | watcher 检查间隔 |
| `--idle-grace N` | `2` | 连续 N 次未发现进程后释放 |
| `--time HOURS` | `168` | 占位 job 预计时长 |

绑定 job 会在被监控进程消失后自动结束。它是过渡保护手段，不是长期替代 Slurm 启动任务的方式。

## Web token

```bash
tmesh web
tmesh web --ttl 24
```

输出形如：

```text
http://server:8000/tokens?<signed-token>
```

无 token 打开 Web 时会进入登录页，可以手动粘贴 token。CLI 会尽量输出可点击链接；在 VS Code Remote 里是否弹出“打开网址”取决于 VS Code 终端集成。

## 临时文件上传

任何 Linux 用户都可以把自己有写权限的目录临时开放成上传入口：

```bash
tmesh upload ~/uploads
tmesh upload /data/alice/inbox --ttl 2
```

目录省略时使用当前工作目录；有效期默认 6 小时，`--ttl` 接受小时数，范围为 1 分钟到 168 小时。命令会输出专属 URL 和一个独立的 256 位上传 token。直接打开 URL 会自动进入 TensorMesh 风格上传页；也可以先打开 `http://server:8000/upload`，再粘贴命令输出的 token，Web 会自动定位对应的临时会话。

上传进程以执行命令的 Linux 用户身份运行，只能写入该用户指定并有权限访问的目录。token 仅对当前上传会话有效，不能访问 TensorMesh 管理 API；会话到期后进程和入口自动关闭。同名文件不会覆盖，会保存为带编号的新副本。

日志保存在：

```text
~/.tensormesh/uploads/<session-id>.log
```

## 提醒命令

查看设置：

```bash
tmesh notice
```

交互配置邮箱和选项：

```bash
tmesh notice config
```

只配置邮箱或只配置选项：

```bash
tmesh notice --mail user@example.com
tmesh notice --option
```

发送测试邮件：

```bash
tmesh notice --test
```

给训练代码生成本地通知 token：

```bash
eval "$(tmesh notice token --export)"
```

手动发送一次本地提醒：

```bash
tmesh notice send --title "训练指标达标" --content "r1=0.72" --log-file .tmesh/137/bash.log --log-lines 24
```

生命周期提醒默认是显式模式。只有提交时带 `--notice` 的 `run` 或 `bash` job 才会触发；也可以在 `tmesh bash` 的命令模式里输入 `notice on`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TENSORMESH_API` | CLI 访问 API 的 base URL，默认 `http://localhost:4317` |
| `TENSORMESH_NODE` | `bin/tmesh` 使用的 Node.js 可执行文件 |
| `TENSORMESH_WEB_URL` | `tmesh web` 输出的 Web base URL |
| `TENSORMESH_WEB_PORT` | Web 端口，默认 `8000` |
| `TENSORMESH_NOTICE_TOKEN` | 用户代码调用 `/api/local-notice` 的 Bearer token |
| `TENSORMESH_OUTPUT` | 可设为 `json` 或 `plain`，等价于默认带 `--json` / `--plain` |
| `TENSORMESH_BASH_TMUX` | 设为 `0` 时禁用 tmux 交互模式 |
| `TENSORMESH_TMUX_SOCKET` | 覆盖 TensorMesh 专用 tmux socket 名 |
| `TENSORMESH_TMUX_RELEASE_ON_DETACH` | 设为 `0` 时恢复 detach 后保留未 submit 会话的旧行为 |
| `TENSORMESH_SRUN` | 覆盖交互 shell 使用的 `srun` 命令 |
