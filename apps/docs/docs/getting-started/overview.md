---
title: 系统概念
---

# 系统概念

TensorMesh 把一台共享 GPU 服务器拆成四个协作层：

- **Slurm 层**：负责作业排队、GPU GRES 分配、cgroup 隔离和取消作业。
- **采集层**：API 服务定时读取 `nvidia-smi`、`ps`、`/proc/stat` 和 Slurm 队列。
- **交互层**：`tmesh` CLI、curses TUI 和 Web 门户给用户使用。
- **协作层**：SQLite 历史、卡时统计、HTML/CSV 导出、邮件提醒和本地代码提醒。

## 用户身份

TensorMesh 沿用 Linux 用户身份。用户 SSH 登录后直接运行 `tmesh`，不需要在 CLI 单独登录。

Web 端通过 `tmesh web` 生成的签名 token 识别当前 Linux 用户。API 在本机 loopback 请求下允许本地用户访问，但从 Web 代理或远端访问 `/api/*` 时需要 token。

## 作业类型

| 类型 | 命令 | 实际机制 |
| --- | --- | --- |
| 后台作业 | `tmesh run --gpus N -- COMMAND...` | 生成临时 sbatch 脚本并提交 Slurm |
| 交互 shell | `tmesh bash --gpus N` | 专用 TensorMesh tmux 包装 `srun --pty`，支持 Esc 命令栏 |
| 预约/未来作业 | `tmesh reserve --at TIME --gpus N -- COMMAND...` | 使用 Slurm `--begin` 提交未来启动 job |
| 共享卡并行（root only） | `sudo tmesh share --gpu-indexes N -- COMMAND...` | root systemd scope，不经过 Slurm、不取消原任务，状态页隐藏共享任务 |
| Web 登记 | `/api/tasks/register` | 写入 TensorMesh SQLite，只影响展示和统计 |

CLI 提交时必须填写 Reason。交互终端会用中文提示输入任务描述；非交互脚本应显式传 `--reason`。

## 排队与空闲资源

默认部署按提交顺序确定优先级，并启用 Slurm backfill。高优先级 job 暂时拿不到指定资源时，后续 job 可以使用不会推迟它的空闲 GPU、CPU 和内存；已经运行的 job 不会被新任务抢占。

申请任意 GPU 的 `--gpus N` 通常比指定物理卡的 `--gpu-indexes ...` 更容易满足。指定卡不会获得更高优先级；如果前序任务只等待某些物理卡，后续任务仍可回填到其他空闲卡。

## 预计时间和硬限制

`--time` 是 TensorMesh 的预计运行时长，用于展示预计结束和发送超时提醒，不会自动停止任务。

Slurm 的硬时间限制由 `--slurm-time` 控制，默认是 `7-00:00:00`。

:::danger 重要：7 天是默认任务硬限制

默认情况下，任务运行满 7 天仍未结束会被 Slurm 自动终止。预计运行时间超过 7 天的实验必须显式设置更长的 `--slurm-time`，例如 `--slurm-time 14-00:00:00`。当前分区允许的最长硬限制是 90 天。

:::

## 登录层和作业层

启用 GPU 登录隔离后，普通 SSH、VS Code 和普通 tmux 里的 `nvidia-smi` 应该看不到 GPU。用户通过 `tmesh run` 或 `tmesh bash` 进入 Slurm job 后，才会看到申请到的卡。

Web/TUI 的全局 GPU 状态来自运行在隔离外的 TensorMesh API，因此即使用户登录 shell 没有 GPU 设备权限，仍然可以查看整机状态。
