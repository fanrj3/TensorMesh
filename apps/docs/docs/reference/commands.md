---
title: 命令速查
---

# 命令速查

这一页只放高频命令和常见组合。需要完整解释时跳回 [CLI 手册](../user-guide/cli.md)。

## 日常查看

| 目标 | 命令 |
| --- | --- |
| 查看自己相关状态 | `tmesh status` |
| 查看全部 GPU、节点和 Slurm job | `tmesh status --all` |
| 查看所有 job | `tmesh jobs` |
| 只看自己的 job | `tmesh jobs --mine` |
| 查看单个 job | `tmesh job <jobid>` |
| 回溯自己的 job 历史 | `tmesh history` |
| 查看原始 nvidia-smi | `tmesh nvidia-smi` |
| 刷新原始 nvidia-smi | `watch -n 2 tmesh nvidia-smi` |
| 查看单张 GPU | `tmesh gpu 0` |

```bash
tmesh status --all
tmesh nvidia-smi
watch -n 2 tmesh nvidia-smi
tmesh jobs --mine
tmesh history --days 30 --limit 100
tmesh job 1842
```

## 提交后台任务

| 目标 | 命令 |
| --- | --- |
| 最小 smoke test | `tmesh run --gpus 1 --time 0.2 --reason "GPU smoke" -- nvidia-smi` |
| 提交训练脚本 | `tmesh run --gpus 1 --time 8 --reason "resnet50" -- python train.py` |
| 指定物理卡 | `tmesh run --gpu-indexes 0,1 --time 8 --reason "双卡训练" -- bash train.sh` |
| 设置 Slurm 硬限制 | `tmesh run --gpus 1 --time 240 --slurm-time 14-00:00:00 --reason "长实验" -- python train.py` |
| 开启结束提醒 | `tmesh run --gpus 1 --notice --reason "训练提醒" -- python train.py` |

```bash
tmesh run --gpus 1 --name smoke --time 0.2 --reason "GPU smoke" -- nvidia-smi
tail -f .tmesh/<JOB_ID>/run.log
```

## 交互式 shell

| 目标 | 命令 |
| --- | --- |
| 打开一张 GPU 的 shell | `tmesh bash --gpus 1 --time 8 --reason "调试"` |
| 进入排队等待 | `tmesh bash --gpus 4 --wait --reason "多卡调试"` |
| 不等待，资源不足时退出 | `tmesh bash --gpus 4 --no-wait --reason "快速检查"` |
| 列出 TensorMesh tmux 会话 | `tmesh ls` |
| 重新进入会话 | `tmesh open <ID>` |
| 关闭会话并取消 job | `tmesh close <ID>` |
| 只关闭会话，不取消 job | `tmesh close <ID> --no-cancel` |

```bash
tmesh bash --gpus 1 --name debug --time 6 --reason "模型调试"
tmesh ls
tmesh open <ID>
```

## 预约和保护已有任务

| 目标 | 命令 |
| --- | --- |
| 预约晚上启动 | `tmesh reserve --at 23:00 --gpus 1 --reason "夜间训练" -- python train.py` |
| 预约指定日期 | `tmesh reserve --at "2026-06-04 09:00" --gpus 2 --reason "上午实验" -- bash train.sh` |
| 预约占位 | `tmesh reserve --at 23:00 --gpus 1 --reason "保留调试"` |
| 保护已有外部任务 | `tmesh bind --gpu-indexes 0,1 --owner USER --reason "已有任务保护"` |

`bind` 是过渡保护手段。长期任务仍建议通过 `tmesh run` 或 `tmesh bash` 进入 Slurm cgroup。

## 管理员共享卡并行任务（tmesh share）

所有卡都被占用时，可以**借用**任意卡（包括正被他人占用的卡）并行跑任务，**不取消原任务**，且 TensorMesh 状态页不显示共享任务（仍显示原任务）。**必须以 root 运行（`sudo tmesh share ...`）**，谁能用由 sudoers 策略决定。

| 目标 | 命令 |
| --- | --- |
| 在占用卡上并行跑 | `sudo tmesh share --gpu-indexes 0,1 --reason "数据清洗" -- python clean.py` |
| 限制资源借用 | `sudo tmesh share --gpu-indexes 6 --memory 8G --cpu-quota 50% -- python eval.py` |
| 查看共享任务 | `sudo tmesh share --list` |
| 停止共享任务 | `sudo tmesh share --cancel <id>` |

详见 [管理员共享卡并行任务](../admin-guide/share.md)。

## 取消作业

直接运行 `tmesh cancel` 会列出当前用户的活动 job。用上下方向键移动，按 `Enter` 选择；随后会显示 job ID、名称、owner、状态、GPU、运行时间、工作目录、命令和 Reason。

已知 ID 时也可以直接运行：

```bash
tmesh cancel <JOB_ID>
```

两种方式都会询问是否确定取消。只有输入 `Y` 后回车才会执行；直接回车或输入其他内容都会退出且不取消。取消命令必须在交互终端中运行，并拒绝取消 owner 不是当前用户的 job。

## Web 和提醒

| 目标 | 命令 |
| --- | --- |
| 生成 Web URL | `tmesh web` |
| 设置 Web token 有效期 | `tmesh web --ttl 24` |
| 临时开放当前目录上传 | `tmesh upload` |
| 临时开放指定目录 2 小时 | `tmesh upload /data/alice/inbox --ttl 2` |
| 查看提醒配置 | `tmesh notice` |
| 配置邮箱 | `tmesh notice --mail user@example.com` |
| 发送测试邮件 | `tmesh notice --test` |
| 导出本地提醒 token | `eval "$(tmesh notice token --export)"` |

```bash
tmesh web --ttl 24
tmesh upload ~/uploads
tmesh notice --mail user@example.com
tmesh notice --test
```

## 输出和脚本化

| 目标 | 命令 |
| --- | --- |
| JSON 状态 | `tmesh status --all --json` |
| JSON job 列表 | `tmesh jobs --json` |
| JSON job 历史 | `tmesh history --json` |
| 纯文本状态 | `tmesh status --all --plain` |
| 默认 JSON 输出 | `TENSORMESH_OUTPUT=json tmesh jobs` |

```bash
tmesh status --all --json
tmesh jobs --mine --plain > jobs.txt
```

## 文档部署

| 目标 | 命令 |
| --- | --- |
| 本地预览文档 | `npm run dev:docs` |
| 构建文档 | `npm run build:docs` |
| 同步到 Web 的 `/doc/` | `npm run deploy:docs:web` |
| 启动 Web 服务（生产） | `npm run start:web` |
| 启动 Web 服务（开发预览） | `npm run dev:web` |

```bash
npm run deploy:docs:web
npm run start:web
```
