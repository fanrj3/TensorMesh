---
title: 服务部署
---

# 服务部署

TensorMesh 由两个长期服务组成：

- API 服务：默认监听 `0.0.0.0:4317`。
- Web 服务：生产模式默认监听 `0.0.0.0:8000`。

服务以「模板 + 渲染」方式安装：仓库提供 systemd 模板，`install.sh` 会把路径、用户等占位符渲染成实际值，并复制到 `/etc/systemd/system/` 后启用。

## 环境文件

模板与示例：

```text
scripts/systemd/tensormesh.env.example
```

`install.sh` 会自动检测主机信息并生成 `/etc/tensormesh/tensormesh.env`。手动安装时：

```bash
sudo install -d -m 755 /etc/tensormesh
sudo cp scripts/systemd/tensormesh.env.example /etc/tensormesh/tensormesh.env
sudoedit /etc/tensormesh/tensormesh.env
```

常用配置见 [配置参考](../reference/configuration.md)。

## API 服务

模板：

```text
scripts/systemd/tensormesh-api.service
```

模板中的占位符由 `install.sh` 渲染为实际值：

| 占位符 | 含义 |
| --- | --- |
| `__REPO_ROOT__` | 仓库安装目录 |
| `__NODE_BIN_DIR__` | Node.js 可执行文件所在目录 |
| `__NPM_BIN__` | npm 可执行文件路径 |

API 服务当前以 root 用户运行，原因是它需要在登录层 GPU 隔离之外读取全局 `nvidia-smi`、进程信息和 Slurm 状态。

模板会在 API 启动前执行 `nvidia-smi -pm 1`。这会在每次开机后启用 NVIDIA persistence mode，避免多卡机器的首次 NVML 初始化超过采集超时。采集器仍保留默认 15 秒的单次命令超时，可通过 `TENSORMESH_NVIDIA_SMI_TIMEOUT_MS` 调整。

渲染后示例（安装目录 `/opt/tensormesh`）：

```ini
[Unit]
Description=TensorMesh API
After=network-online.target munge.service slurmctld.service slurmd.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tensormesh
EnvironmentFile=-/etc/tensormesh/tensormesh.env
Environment=PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
# Enable GPU persistence mode when the driver supports it; failures are ignored.
ExecStartPre=-/usr/bin/nvidia-smi -pm 1
ExecStart=/usr/local/bin/npm run start:server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

手动安装时，先把模板中的占位符替换为实际路径，再安装启用：

```bash
# 先将 __REPO_ROOT__、__NODE_BIN_DIR__、__NPM_BIN__ 替换为实际值
sudo cp scripts/systemd/tensormesh-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tensormesh-api.service
sudo systemctl status tensormesh-api.service --no-pager
```

健康检查：

```bash
curl http://localhost:4317/health
```

## Web 服务

模板：

```text
scripts/systemd/tensormesh-web.service
```

占位符在 API 服务基础上增加了 `__SERVICE_USER__`：

| 占位符 | 含义 |
| --- | --- |
| `__SERVICE_USER__` | 以非 root 身份运行 Web 服务的系统用户 |

渲染后示例（安装目录 `/opt/tensormesh`，`<服务用户>` 为实际运行 Web 的用户）：

```ini
[Unit]
Description=TensorMesh Web
After=network-online.target tensormesh-api.service
Wants=network-online.target

[Service]
Type=simple
User=<服务用户>
WorkingDirectory=/opt/tensormesh
EnvironmentFile=-/etc/tensormesh/tensormesh.env
Environment=PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/bin/npm run start:web
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

手动安装：

```bash
# 先将模板中的占位符替换为实际值
sudo cp scripts/systemd/tensormesh-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tensormesh-web.service
sudo systemctl status tensormesh-web.service --no-pager
```

两个服务都以生产模式启动：`npm run start:server` 与 `npm run start:web`（Web 的 `start` 是 `vite preview`，服务于构建产物）；本地开发预览才使用 `npm run dev:server` 与 `npm run dev:web`。

用户访问入口仍然是：

```bash
tmesh web
```

## 文档站部署到 8000/doc

文档站在 `apps/docs`，开发预览：

```bash
npm run dev:docs
```

构建静态文件：

```bash
npm run build:docs
```

输出目录：

```text
apps/docs/build/
```

当前 Docusaurus 配置的 `baseUrl` 是：

```text
/doc/
```

因此局域网中推荐访问路径是：

```text
http://server:8000/doc/
```

如果 Web 服务也由 Vite 在 8000 端口提供，可以把构建产物复制到 Web 静态目录：

```bash
npm run deploy:docs:web
```

`apps/web/vite.config.ts` 已经把 `/doc` 注册为独立静态路径，并且放在 Web SPA fallback 之前处理。否则访问 `/doc/` 时会被 Vite 回退到 Web 应用入口；没有 token 的浏览器就会看到 GPU mock 页面，而不是文档站。

随后以生产模式启动 Web 服务：

```bash
npm run start:web
```

开发预览则使用 `npm run dev:web`。

这样 Web 控制台仍在：

```text
http://server:8000/
```

文档站在：

```text
http://server:8000/doc/
```

生产部署也可以用 Nginx 把 `/doc/` 指向 `apps/docs/build/`，但需要保持子路径 `/doc/` 不变，否则静态资源路径会失效。

## Web 前缀代理注册表

TensorMesh Web 默认占用 8000 端口。其他本机服务如果也希望通过同一个 8000 端口对外提供访问，不需要再开新的公网端口，可以把自己的 URL 前缀注册到 Web 前缀代理表。

推荐接入方式是：

1. 让业务服务只监听本机地址，例如 `127.0.0.1:9001`。
2. 为业务服务选择一个不会冲突的公开前缀，例如 `/my_service`。
3. 把 `前缀=目标服务地址` 写入 `/etc/tensormesh/tensormesh.env`。
4. 重启 `tensormesh-web`。
5. 通过 `http://server:8000/<前缀>` 验证访问。

内置代理包括：

| 前缀 | 目标 |
| --- | --- |
| `/api` | `http://127.0.0.1:4317` |
| `/health` | `http://127.0.0.1:4317` |

### 最简单的接入方式

如果后端服务本身已经提供同名路径，例如：

```text
http://127.0.0.1:9001/my_service
```

则只需要在 `/etc/tensormesh/tensormesh.env` 里追加：

```bash
TENSORMESH_WEB_PROXY_REGISTRY=/my_service=http://127.0.0.1:9001
```

然后重启 Web：

```bash
sudo systemctl restart tensormesh-web
```

注册后，访问：

```text
http://server:8000/my_service?city=example&lat=0.0&lon=0.0&time=2024-05&heading=90
```

会转发到：

```text
http://127.0.0.1:9001/my_service?city=example&lat=0.0&lon=0.0&time=2024-05&heading=90
```

也就是说，默认情况下代理不会删除前缀。外部请求中的 `/my_service` 会原样传给目标服务。

### 注册多个服务

如果要挂多个服务，可以用分号、换行或 JSON。简单写法：

```bash
TENSORMESH_WEB_PROXY_REGISTRY='/my_service=http://127.0.0.1:9001;/another_service=http://127.0.0.1:9002'
```

JSON 写法：

```bash
TENSORMESH_WEB_PROXY_REGISTRY='[
  {"prefix":"/my_service","target":"http://127.0.0.1:9001"},
  {"prefix":"/another_service","target":"http://127.0.0.1:9002"}
]'
```

配置较多时建议放到文件里：

```bash
TENSORMESH_WEB_PROXY_REGISTRY_FILE=/etc/tensormesh/web-proxy-registry.json
```

示例文件：

```json
{
  "/my_service": "http://127.0.0.1:9001",
  "/another_service": "http://127.0.0.1:9002"
}
```

修改注册表文件后同样需要重启：

```bash
sudo systemctl restart tensormesh-web
```

### 后端服务只监听根路径时

有些服务只提供根路径，例如后端实际是：

```text
http://127.0.0.1:9001/
```

但希望外部通过：

```text
http://server:8000/my_service
```

访问。这种情况需要使用 JSON 并设置 `rewritePrefix` 为空字符串：

```bash
TENSORMESH_WEB_PROXY_REGISTRY='[
  {"prefix":"/my_service","target":"http://127.0.0.1:9001","rewritePrefix":""}
]'
```

这样 `/my_service/api/items` 会转发成目标服务的 `/api/items`，而不是 `/my_service/api/items`。

### 验证方法

以 `/my_service` 为例，先确认后端服务本身可访问：

```bash
curl -I 'http://127.0.0.1:9001/my_service?city=example&lat=0.0&lon=0.0&time=2024-05&heading=90'
```

再确认 8000 端口代理可访问：

```bash
curl -I 'http://127.0.0.1:8000/my_service?city=example&lat=0.0&lon=0.0&time=2024-05&heading=90'
```

如果是图片服务，正常响应通常会包含：

```text
content-type: image/jpeg
```

如果代理失败，先看 Web 日志：

```bash
sudo journalctl -u tensormesh-web -n 80 --no-pager
```

### 限制和注意事项

前缀不能覆盖 TensorMesh 自己的 `/api`、`/health`、`/doc`、`/tokens`。前缀必须以 `/` 开头，不能是单独的 `/`，也不能包含空格、查询参数或 hash。

目标地址必须是 `http://` 或 `https://`，不要在 URL 中写用户名密码。需要鉴权的业务服务应自行在服务层处理 token、cookie 或请求头。

`tensormesh-web` 启动时读取注册表。修改 `/etc/tensormesh/tensormesh.env` 或注册表文件后，需要重启 `tensormesh-web` 才会生效。
