---
title: 管理员共享卡并行任务
---

# 管理员共享卡并行任务（tmesh share）

当所有 GPU 都被占用时，管理员可以直接**借用**任意一张卡（包括正在被他人
Slurm 任务占用的卡）并行跑自己的任务，**不需要取消对方的任务**。TensorMesh
状态页不会显示这个共享任务，卡片上仍然只显示原来用户的任务。

## 前置条件

- `tmesh share` 必须通过 `sudo` 以 root 运行（**sudo 权限模型**：谁能用由
  sudoers 策略决定，TensorMesh 只校验进程是否为 root）：

```bash
sudo tmesh share --gpu-indexes 6,7 -- python clean.py
```

  非 root 直接运行会提示使用 sudo。
- 被借用的卡有足够的剩余显存（共享任务与原来的任务并行运行，共用显存）。

## 基本用法

```bash
# 在 GPU 6 和 7 上并行跑任务（无论这两张卡是否已被占用）
sudo tmesh share --gpu-indexes 6,7 --reason "白天跑数据清洗" -- python clean.py

# 常用参数
sudo tmesh share --gpu-indexes 0 \
  --name share-clean \
  --reason "借用 0 号卡" \
  --cwd /data/proj \
  --memory 8G \
  --cpu-quota 50% \
  --output /tmp/share.log \
  -- python train.py --epochs 10
```

`tmesh share` 会阻塞直到命令结束，退出码与命令一致。日志默认写到
`<cwd>/.tmesh/shared/<id>.log`。

## 原理

共享任务**不经过 Slurm**：`tmesh share` 用 `sudo systemd-run --scope` 在
root 的 systemd scope（`/system.slice/shared-<id>.scope`）中启动命令，因此：

- 不占用 Slurm 资源，不需要排队，立即开始；
- **不取消、不影响**原来用户的 Slurm 任务（对方的任务原样运行）；
- 通过 `CUDA_VISIBLE_DEVICES` 限定只能看到被借用的卡。

TensorMesh 服务端在采集 GPU 状态时，会把属于已注册共享 scope 的进程过滤掉，
所以 `tmesh status` / Web / TUI 都看不到共享任务，卡片上显示的仍是原来用户
的任务。原始的 `tmesh nvidia-smi` 不做过滤，能看到真实进程。

## 管理命令

```bash
# 查看当前活跃的共享任务
sudo tmesh share --list

# 停止某个共享任务（终止 systemd scope 并注销）
sudo tmesh share --cancel <id>
```

命令正常结束时注册项会自动注销；如果进程被 kill 或机器重启，服务端会通过
检查 scope 是否还存在来自动清理过期注册项。

## 资源限制

借用他人正在使用的卡时，建议用 `--memory` / `--cpu-quota` 限制共享任务的
资源占用，避免影响原任务：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `--memory 8G` | `--memory 8G` | systemd `MemoryMax` 上限（支持 `8G`、`4096M`） |
| `--cpu-quota 50%` | `--cpu-quota 50%` | systemd `CPUQuota` 上限（50% = 半个 CPU） |

## 权限模型

- `tmesh share` **只允许 root 运行**（`sudo tmesh share ...`）。
- 谁有权限使用由 sudoers / PAM 策略决定；TensorMesh 端不做用户白名单，只
  校验进程 uid 是否为 0，API 端也只接受 `root` 身份。
- 服务端注册表只接受 `root` 用户的登记/注销请求。

## 注意事项

- 共享任务与原来的任务共享显存，注意检查目标卡的剩余显存（`tmesh gpu <id>`）。
- `tmesh nvidia-smi` 不做隐藏，显示真实进程，适合核对。
- 状态页上被借用卡的显存/利用率会反映共享任务的真实占用（如实展示），但
  任务列表只显示原来用户的任务。
