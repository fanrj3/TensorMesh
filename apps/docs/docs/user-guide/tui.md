---
title: TUI 使用
---

# TUI 使用

裸 `tmesh` 会进入 Python 标准库 `curses` 写的全屏 TUI：

```bash
tmesh
```

这是当前推荐的全屏入口。也可以显式运行：

```bash
tmesh tui
```

## 数据来源

TUI 优先读取 TensorMesh API：

```text
http://localhost:4317/api/status
```

API 不可达时会尝试本机 Slurm 和 `nvidia-smi`。如果登录层已经启用 no-GPU 隔离，而 API 又没有运行在隔离外，普通用户 TUI 可能无法看到 GPU telemetry。正常部署下 API 以隔离外服务运行，因此普通用户仍能在 TUI 看到全局状态。

## 常用按键

Python curses TUI 支持队列、GPU、节点、详情面板和命令面板。常用操作：

| 按键 | 作用 |
| --- | --- |
| `Tab` | 在 job 队列和 GPU 列表之间切换 |
| `j/k` 或方向键 | 移动选择 |
| `Enter` | 查看当前 job 或 GPU 详情 |
| `r` | 基于提示提交后台 `tmesh run` |
| `i` | 基于提示打开 `tmesh bash` 交互 shell |
| `b` | 基于提示提交 `tmesh reserve` |
| `x` | 取消当前 job 或输入 job id |
| `R` | 刷新状态 |
| `/` | 打开命令面板，支持方向键选择和 Tab 补全 |
| `q` 或 `Esc` | 退出 |

TUI 中的 `r`、`i`、`b` 会逐项询问 GPU、名称、预计时长、Reason 和命令，再调用对应 CLI 命令。复杂提交仍建议直接写完整命令，便于复制和审阅。

## 命令面板

按 `/` 后可以选择：

| 命令 | 作用 |
| --- | --- |
| `run` | 在选中 GPU 上提交后台任务 |
| `bash` | 在选中 GPU 上打开交互 shell |
| `reserve` | 预约未来作业 |
| `cancel` | 取消当前或指定 job |
| `refresh` | 刷新状态 |
| `detail` | 打开选中项详情 |
| `jobs` | 切换到 job 面板 |
| `gpus` | 切换到 GPU 面板 |
| `quit` | 退出 TUI |

Node CLI 里仍保留一个较旧的简易 TUI 实现；`bin/tmesh` 无参数时实际调用的是 Python curses 版本。
