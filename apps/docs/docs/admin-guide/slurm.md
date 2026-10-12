---
title: Slurm 集成
---

# Slurm 集成

TensorMesh 当前面向单机 Slurm 部署：一台 GPU 服务器上运行 `slurmctld`、`slurmd`、MUNGE 和 TensorMesh 服务。

## 生成配置参考

在仓库根目录运行：

```bash
npm --workspace @tensormesh/cli run slurm:config
```

该命令会按当前机器生成三段配置：

- `/etc/slurm-llnl/slurm.conf`
- `/etc/slurm-llnl/gres.conf`
- `/etc/slurm-llnl/cgroup.conf`

默认读取：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TENSORMESH_SLURM_HOST` | `hostname -s` | Slurm 控制节点和计算节点名 |
| `TENSORMESH_SLURM_GPU_COUNT` | `8` | 生成 typed GRES 的 GPU 数量 |
| `TENSORMESH_SLURM_THREADS_PER_CORE` | `2` | CPU 拓扑 |
| `TENSORMESH_SLURM_SOCKETS` | `2` | CPU socket 数 |

生成的 `gpu` 分区配置使用 `MaxTime=90-00:00:00`，因此用户可以显式提交最长 90 天的任务。TensorMesh 的单任务默认硬限制仍是 7 天；超过 7 天时需要通过 `--slurm-time` 指定，例如 `--slurm-time 31-00:00:00`。

## 优先级与空闲资源回填

TensorMesh 的默认 Slurm 配置使用：

```text
PriorityType=priority/basic
SchedulerType=sched/backfill
PreemptType=preempt/none
PreemptMode=OFF
```

`priority/basic` 按提交顺序确定优先级。`sched/backfill` 会先保护高优先级 job 的预计启动时间，再允许后提交的 job 使用不冲突的空闲 GPU、CPU 和内存。

例如，前面的 job 只等待 `gpu6` 或 `gpu7`，而 `gpu0` 到 `gpu5` 空闲时，后续 `--gpus 1` job 可以立即使用空闲卡。若后续 job 会推迟前序 job，则仍然保持等待。`PreemptType=preempt/none` 表示排队任务不会抢占已经运行的任务。

:::caution 回填依赖硬时间限制

`sched/backfill` 使用 job 的 Slurm 硬时间限制判断是否会推迟前序任务。`--slurm-time` 应填写可信的上限；设置得过长会减少可回填机会，但不会改变任务优先级，也不会触发抢占。

:::

`SchedulerType` 的修改必须重启 `slurmctld`，仅执行 `scontrol reconfigure` 不会生效。

## typed GRES

生成器会把物理 GPU 写成：

```text
Name=gpu Type=gpu0 File=/dev/nvidia0
Name=gpu Type=gpu1 File=/dev/nvidia1
```

这样 `tmesh run --gpu-indexes 0,1` 可以映射到：

```text
--gres=gpu:gpu0:1,gpu:gpu1:1
```

如果只使用 `--gpus 2`，TensorMesh 会提交：

```text
--gres=gpu:2
```

## 必需 Slurm 能力

TensorMesh 依赖以下 Slurm 命令：

- `squeue`
- `sinfo`
- `scontrol`
- `sbatch`
- `srun`
- `scancel`

建议启用：

```text
ProctrackType=proctrack/cgroup
TaskPlugin=task/cgroup,task/affinity
SelectType=select/cons_tres
GresTypes=gpu
PriorityType=priority/basic
SchedulerType=sched/backfill
PreemptType=preempt/none
ConstrainDevices=yes
ConstrainCores=yes
ConstrainRAMSpace=yes
```

## 冒烟测试

Slurm 配好后先验证底层能力：

```bash
sinfo
scontrol show node "$(hostname -s)"
srun --partition=gpu --gres=gpu:1 nvidia-smi
```

再验证 TensorMesh：

```bash
tmesh status
tmesh run --gpus 1 --name smoke --time 0.1 --reason "Slurm smoke" -- nvidia-smi
```
