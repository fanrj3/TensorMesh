---
title: Web 门户
---

# Web 门户

Web 端定位为查看和轻量操作入口，不负责替代 CLI 提交作业。

## 登录方式

用户在 SSH shell 中运行：

```bash
tmesh web
```

命令会为当前 Linux 用户生成一个有过期时间的签名 token，并输出局域网 URL。

可选有效期：

```bash
tmesh web --ttl 24
```

token secret 默认按 Linux 用户保存到：

```text
~/.tensormesh/web-token-secret
```

没有 token 直接打开 Web 时会看到登录页。把 `tmesh web` 输出 URL 中 `tokens?` 后面的 token 粘贴进去即可进入；这用于确认请求来自该 Linux 用户的 SSH 会话，而不是局域网里随机扫描到端口的设备。

## 页面能力

当前 Web 页面提供：

- GPU 当前状态：显存、利用率、温度、用户、进程、任务和 Slurm 已占用卡。
- Slurm job 列表：状态、GRES、运行时间、原因、工作目录和命令。
- GPU 历史曲线：最近 30 分钟、2 小时、6 小时、24 小时、7 天、14 天和自定义范围。
- GPU 历史筛选：按 GPU 勾选显示，默认显示活跃卡；服务器端按时间窗聚合，前端可在图表底部拖拽局部放大。
- 用户卡时统计：可从 API 返回的所有用户中选择，查看近 14 天卡时和任务来源。
- CPU 信息：总体利用率、load average、核心数和 8x8 核心热力图。
- 导出：当前 Slurm job 表和过去 14 天 0 点快照，支持 HTML/CSV API。
- 个人设置：提醒邮箱、提醒模式、提醒选项和测试邮件。
- 本人 job 操作：查看本人 job 日志尾部，取消本人运行中或等待中的 job。

Slurm 已分配但暂时没有 GPU 进程的卡会显示为“已占用/预留”，不会再被误判为空闲。这样 `tmesh bash` 里只是开着 shell、还没启动 Python 的情况也能在 Web 上反映出来。

## 导出和审阅

顶部按钮提供：

| 按钮 | API | 用途 |
| --- | --- | --- |
| Job 表格 | `/api/export/current.html` | 当前 Slurm job 审阅 |
| 14天0点 | `/api/export/midnight.html` | 每天 0 点快照报备 |

对应 CSV 路径也存在：

```text
/api/export/current.csv
/api/export/midnight.csv
```

## 当前限制

- Web 页面文案仍保留“查看门户”的产品定位。
- 任务登记和预约弹窗代码、对应 API 已存在，但当前主界面没有稳定入口按钮；正式用户流程仍建议使用 `tmesh run`、`tmesh bash` 和 `tmesh reserve`。
- Web token 不是密码登录系统，适合内网共享服务器，不应暴露到公网。
