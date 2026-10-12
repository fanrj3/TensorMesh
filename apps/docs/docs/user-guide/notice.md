---
title: 提醒与本地通知
---

# 提醒与本地通知

TensorMesh 的提醒系统分两类：

- **Job 生命周期提醒**：服务端根据 Slurm 状态和用户设置发送邮件。
- **本地代码提醒**：用户训练脚本主动调用 `/api/local-notice` 发送自定义提醒。

邮件提醒需要管理员在服务端同时配置 `TENSORMESH_CLOUDMAIL_ENDPOINT` 与 token（见 [配置参考](../reference/configuration.md)）。未配置时邮件提醒功能禁用，其余功能正常。

## 配置邮箱

查看当前设置：

```bash
tmesh notice
```

交互配置：

```bash
tmesh notice config
```

配置界面分两页：

| 页面 | 作用 |
| --- | --- |
| `NOTICE MAIL` | 输入或清除提醒邮箱，原邮箱会预填 |
| `NOTICE OPTION` | 用方向键移动、空格勾选、`m` 切换显式/全局模式、Enter 保存 |

只配置邮箱：

```bash
tmesh notice --mail user@example.com
```

只配置提醒选项：

```bash
tmesh notice --option
```

发送测试邮件：

```bash
tmesh notice --test
```

## 提醒模式

用户设置中有两种模式：

| 模式 | 行为 |
| --- | --- |
| `explicit` | 默认模式。只有提交时带 `--notice` 的 job 会触发生命周期提醒 |
| `global` | 对该用户符合条件的 job 全局发送提醒 |

可配置的提醒项：

- job 自然完成。
- 预约或排队 job 从 `PENDING` 进入 `RUNNING`。
- job 超过 `--time` 预计结束时间但仍未结束。
- 运行中 job 在指定窗口内 GPU 平均利用率低于阈值。

主动 `cancel`、交互 shell 退出或断开导致的取消不会发送“自然完成”提醒。

CLI 的选项界面负责切换模式和勾选项；低利用率窗口与阈值当前主要通过 Web/API 设置。

## 显式开启 job 提醒

显式模式下提交时加 `--notice`：

```bash
tmesh run --gpus 1 --notice --reason "长训练" -- python train.py
tmesh bash --gpus 1 --notice --reason "交互训练"
```

已经进入 `tmesh bash` 后，也可以按 `Esc` 打开命令模式：

```text
notice on
notice off
```

这些命令会更新当前 Slurm job comment 中的 TensorMesh notice 标记。

## 从代码发送提醒

先导出 token：

```bash
eval "$(tmesh notice token --export)"
```

Python 示例：

```python
import os
import requests

api = os.environ.get("TENSORMESH_API", "http://localhost:4317")
token = os.environ["TENSORMESH_NOTICE_TOKEN"]

requests.post(
    f"{api}/api/local-notice",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    json={
        "title": "Metric reached",
        "content": "r1=0.721 exceeded threshold=0.700",
        "logTail": "optional log tail text",
    },
    timeout=10,
).raise_for_status()
```

也可以直接用 CLI：

```bash
tmesh notice send --title "训练完成" --content "run_42 finished" --log-file runs/run_42.log
```

服务端默认对每个用户 30 分钟内立即发送 3 封本地代码提醒，超额请求进入队列并在配额恢复后汇总发送。

邮件正文会使用和 Web UI 一致的简洁卡片风格；job 生命周期邮件会在底部附带可折叠日志尾部。
