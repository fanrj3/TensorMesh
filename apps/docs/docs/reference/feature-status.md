---
title: 功能状态
---

# 功能状态

本页按代码入口审计当前功能，不以旧 `docs/` 目录为准。

## 已实现的主路径

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| CLI 状态查看 | 可用 | `status`、`gpu`、`jobs`、`job`、`cancel` |
| CLI 作业提交 | 可用 | `run` 使用 `sbatch`，`bash` 使用专用 tmux + `srun --pty`，`reserve` 使用 `--begin` |
| 管理员共享卡并行任务 | 可用 | `share` 用 root systemd scope 在占用卡上并行跑任务，不取消原任务，状态页隐藏共享任务；需 `sudo tmesh share`（root 专属，sudoers 决定授权） |
| 交互 shell 命令栏 | 可用 | `Esc` 后支持 `submit`、`job`、`jobs`、`status`、`log`、`close`、`cancel`、`notice`、`help`；中键打开 tmux 弹出菜单 |
| TensorMesh tmux 会话 | 可用 | `ls`、`open`、`close` 管理专用会话，不影响普通 tmux |
| 交互 shell Agent API | 可用 | `/api/tmux/sessions` 可读取 session/pane/log，`/input` 可向原始 shell pane 发送命令 |
| 外部任务绑定 | 可用 | `bind` 用 Slurm 占位保护已有非 Slurm GPU 进程 |
| Web token | 可用 | `tmesh web` 生成带过期时间的签名 URL |
| 临时文件上传 | 可用 | `tmesh upload [DIR] --ttl HOURS` 启动用户态临时服务，随机 token 仅限当前会话，到期自动退出 |
| Web 查看门户 | 可用 | GPU、Slurm job、历史、CPU 热力图、卡时、导出和提醒设置 |
| API 采集 | 可用 | `nvidia-smi`、进程、CPU、Slurm 状态和 SQLite 历史 |
| CLI `history` | 可用 | 当前用户 Slurm job 历史，API/SQLite 主路径，`sacct` fallback |
| 邮件提醒 | 可用 | 完成、预约开始、预计超时、低利用率、本地代码提醒 |
| systemd 模板 | 可用 | API/Web systemd 模板，`install.sh` 渲染占位符并安装 |
| 安装脚本 | 可用 | 仓库根目录 `./install.sh`：环境检查、`npm ci`、构建 Web 与文档站、生成 `/etc/tensormesh/tensormesh.env`、渲染并安装 systemd 服务、链接 `bin/tmesh` 到 `/usr/local/bin`、健康自检 |
| Slurm 配置生成 | 可用 | 单机 Slurm + typed GRES + cgroup 配置参考 |
| PAM GPU 隔离 | 可用 | 安装、启用、应用、恢复和查看策略；CPU quota 默认关闭 |

## 已实现但需谨慎表述

| 模块 | 状态 | 文档口径 |
| --- | --- | --- |
| Web 任务登记 | API 和弹窗存在 | 当前主界面没有稳定入口按钮，作为 API/内部能力说明 |
| Web 预约登记 | API 和弹窗存在 | 当前不自动执行命令，推荐用户使用 `tmesh reserve` |
| CLI `usage` | mock | 真实卡时请用 Web/API |
| 过渡 GPU isolation daemon | 可用 | 作为过渡方案，不作为推荐长期路径 |
| 非 tmux 交互包装器 | 可用 | `TENSORMESH_BASH_TMUX=0` 时启用，作为回退路径 |

## 不应写成已实现的能力

- 多节点 Slurm 集群部署指南。
- Web 端提交 Slurm 作业的正式产品入口。
- 公开公网认证、权限系统或多角色 RBAC。
- 自动资源审批或公平调度策略。
- 长期稳定包安装器或发布版二进制。

新增功能时先更新本页，再补充对应用户/管理员文档。
