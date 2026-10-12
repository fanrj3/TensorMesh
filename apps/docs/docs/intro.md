---
sidebar_position: 1
title: 文档总览
---

# TensorMesh 文档总览

TensorMesh 是面向共享研究服务器的 GPU 使用管理平台。当前代码实现的核心路径是：

- 普通用户通过 `tmesh` 查看 GPU/Slurm 状态，提交后台 GPU 作业，打开交互式 Slurm shell，取消自己的作业。
- Web 门户提供查看、导出、个人提醒配置、本人 job 日志尾部查看和本人 job 取消。
- 服务端采集 `nvidia-smi`、CPU、Slurm 队列和历史采样，写入 SQLite，并按 token 识别用户。
- 管理员可以使用项目脚本生成单机 Slurm 配置、安装 systemd 服务、启用登录层 no-GPU 策略。

这套文档不是从旧 `docs/` 目录直接搬运，而是按当前代码入口重新整理。旧文档可以继续作为草稿和历史材料，新文档以 `apps/docs/docs/` 为维护入口。

## 当前边界

TensorMesh 不是独立调度器。GPU 资源的最终分配、隔离和作业生命周期由 Slurm 管理，TensorMesh 负责把常用操作封装成更容易使用的 CLI/Web 工作流。

当前默认策略是先让用户走 `tmesh run` / `tmesh bash` 提交任务，再逐步收紧普通登录 shell 对 GPU 的直接访问。

## 推荐阅读顺序

1. 普通用户先读 [快速开始](./getting-started/quickstart.md) 和 [CLI 使用](./user-guide/cli.md)。
2. 管理员先读 [Slurm 集成](./admin-guide/slurm.md) 和 [服务部署](./admin-guide/services.md)。
3. 只想查命令时读 [命令速查](./reference/commands.md)。
4. 需要联调前端或外部脚本时读 [HTTP API](./reference/api.md) 和 [配置参考](./reference/configuration.md)。
