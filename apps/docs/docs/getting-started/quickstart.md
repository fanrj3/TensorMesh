---
title: 快速开始
---

# 快速开始

## 前提

管理员需要先完成：

- 安装 Node.js 22 或更高版本。
- 配好单机 Slurm、MUNGE 和 GPU GRES。
- 部署 TensorMesh 的 API 和 Web 服务（见下方「安装服务」）。
- 让用户可以直接运行 `tmesh`（安装脚本会链接到 `/usr/local/bin/tmesh`）。

## 安装服务（管理员）

推荐在仓库根目录运行安装脚本，例如安装目录 `/opt/tensormesh`：

```bash
cd /opt/tensormesh
./install.sh
```

`install.sh` 会完成：

- 环境检查（Node.js、npm、Slurm/MUNGE 等依赖）。
- `npm ci` 安装依赖。
- 构建 Web 与文档站。
- 生成 `/etc/tensormesh/tensormesh.env`。
- 渲染并安装 systemd 服务（`tensormesh-api`、`tensormesh-web`）。
- 把 `bin/tmesh` 链接到 `/usr/local/bin/tmesh`。
- 健康自检并启动服务。

也可以手动安装：

```bash
cd /opt/tensormesh
npm ci
npm run deploy:docs:web
npm run build:web
# 生成并编辑环境文件
sudo install -d -m 755 /etc/tensormesh
sudo cp scripts/systemd/tensormesh.env.example /etc/tensormesh/tensormesh.env
sudoedit /etc/tensormesh/tensormesh.env
```

然后按 [服务部署](../admin-guide/services.md) 的说明渲染并安装 systemd 服务并启动。手动安装时，仓库内 CLI 的完整路径是 `bin/tmesh`。

## 查看状态

```bash
tmesh status
```

这个命令会优先展示 Slurm 节点和作业，再展示 API 或本机 `nvidia-smi` 能拿到的 GPU 状态。

如果想看原始 `nvidia-smi` 视图：

```bash
tmesh nvidia-smi
watch -n 2 tmesh nvidia-smi
```

普通登录 shell 被 GPU 隔离，直接运行 `nvidia-smi` 会失败；请使用 `tmesh nvidia-smi`。如果管理员安装了提示脚本，你会看到一段引导信息。

如果只想看 TensorMesh API 返回的数据：

```bash
tmesh status --api
```

## 提交一个后台 GPU 作业

```bash
tmesh run --gpus 1 --name smoke --time 0.2 --reason "GPU smoke" -- nvidia-smi
```

默认日志路径是当前目录下：

```text
.tmesh/<JOB_ID>/run.log
```

`--time` 只表示预计时长。需要设置 Slurm 硬限制时使用：

:::danger 重要：默认硬限制是 7 天

如果任务预计会运行超过 7 天，必须显式传入更长的 `--slurm-time`。否则 job 到 7 天仍未结束时会被 Slurm 自动终止。当前分区允许的最长硬限制是 90 天。

:::

```bash
tmesh run --gpus 1 --time 2 --slurm-time 02:00:00 --reason "两小时训练" -- python train.py
```

## 打开交互式 GPU shell

```bash
tmesh bash --gpus 1 --name debug --time 10 --reason "交互调试"
```

进入 shell 后运行训练命令。提示符会带上 Slurm job ID，例如 `[T137]`。按单独的 `Esc` 可以打开 TensorMesh 命令栏；鼠标中键会打开原来的 tmux 弹出菜单。命令栏常用命令包括：

| 命令 | 作用 |
| --- | --- |
| `job` | 查看当前 Slurm job |
| `jobs` | 查看队列 |
| `status` | 查看集群/GPU 状态 |
| `log` | 查看当前 `.tmesh/<JOB_ID>/bash.log` |
| `notice on` / `notice off` | 修改当前 job 的提醒标记 |
| `submit` | 在检测到真实工作进程时把交互 job 留在后台 |
| `cancel` | 取消当前交互 job |

如果 GPU 不足，`tmesh bash` 会先提示是否继续进入 tmux 等待 Slurm 排队；脚本场景可以用 `--wait` 或 `--no-wait` 明确选择。

## 预约一个未来作业

```bash
tmesh reserve --at 23:00 --gpus 1 --name night_train --time 8 --reason "夜间训练" -- python train.py
```

`reserve` 使用 Slurm `--begin`，是真正的未来启动 job。Web 里的预约登记只是展示和协调记录，默认不会自动执行命令。

## 管理员：全卡占用时借用卡并行跑（root only）

所有 GPU 都被占用时，管理员可以借用任意卡（包括正被他人占用的卡）并行跑任务，**不取消原任务**：

```bash
sudo tmesh share --gpu-indexes 6,7 --reason "数据清洗" -- python clean.py
sudo tmesh share --list
sudo tmesh share --cancel <id>
```

共享任务在 TensorMesh 状态页隐藏（只显示原来用户的任务），`tmesh nvidia-smi` 仍显示真实进程。谁能用由 sudoers 策略决定。

## 打开 Web 门户

```bash
tmesh web
```

命令会输出带 token 的局域网 URL，例如：

```text
http://server:8000/tokens?<signed-token>
```

Web 端可以查看 GPU 状态、Slurm job、历史曲线、卡时统计，当前用户还可以查看自己的 job 日志尾部、取消自己的运行/等待 job、配置提醒邮箱。

如果直接打开 `http://server:8000/` 没有 token，会看到登录页；把 `tmesh web` 输出的 token 粘贴进去即可进入。
