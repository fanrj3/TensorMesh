---
title: 文档维护
---

# 文档维护

新文档站位于：

```text
apps/docs/
```

旧目录：

```text
docs/
```

继续保留为历史材料和草稿，不再作为发布文档的唯一来源。

## 本地预览

```bash
npm run dev:docs
```

## 构建

```bash
npm run build:docs
```

构建输出：

```text
apps/docs/build/
```

同步到 Web 服务的 `/doc/` 静态目录：

```bash
npm run deploy:docs:web
```

## 维护规则

1. 文档必须以代码实际入口为准：CLI 看 `apps/cli/src/index.ts`，API 看 `apps/server/src/index.ts`，Web 看 `apps/web/src/App.tsx`。
2. 用户可直接使用的能力写进用户指南；只有 API 或内部状态存在的能力写进参考或功能状态，不写成主流程。
3. 涉及 root、systemd、PAM、Slurm 配置的命令必须明确管理员身份和风险。
4. 新增 CLI 子命令、API 路由、Web 操作、环境变量或脚本时同步更新：
   - 对应指南页。
   - [配置参考](../reference/configuration.md)。
   - [功能状态](../reference/feature-status.md)。
5. 避免复制旧文档的大段内容；先核对代码，再重写成稳定用户流程。

## 部署建议

内网服务器推荐静态部署 `apps/docs/build/`，例如 Nginx 或对象存储。GitHub Pages 也可用，但需要根据仓库 URL 修改：

```ts
url: "https://<org>.github.io",
baseUrl: "/<repo>/",
```

如果部署到独立域名或内网根路径，保持：

```ts
baseUrl: "/",
```
