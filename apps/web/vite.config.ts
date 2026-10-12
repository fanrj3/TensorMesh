import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin, type PreviewServer, type ProxyOptions } from "vite";

const docsBase = "/doc";
const webProxyHeader = "x-tensormesh-web-proxy";
const prefixProxyHeader = "x-tensormesh-prefix-proxy";
const proxyIdleTimeoutMs = (() => {
  const parsed = Number(process.env.TENSORMESH_WEB_PROXY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

interface ProxyRegistryEntry {
  prefix: string;
  target: string;
  changeOrigin?: boolean;
  rewritePrefix?: string;
  ws?: boolean;
  secure?: boolean;
  headers?: Record<string, string>;
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8"
};

type MiddlewareNext = (err?: unknown) => void;

function sendFile(filePath: string, res: ServerResponse<IncomingMessage>) {
  const stat = fs.statSync(filePath);
  res.statusCode = res.statusCode === 200 ? 200 : res.statusCode;
  res.setHeader("Content-Type", mimeTypes[path.extname(filePath)] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(filePath).pipe(res);
}

function serveDocsRequest(
  docsRoot: string,
  requestUrl: string | undefined,
  res: ServerResponse<IncomingMessage>,
  next: MiddlewareNext
) {
  if (!requestUrl) {
    next();
    return;
  }

  const pathname = new URL(requestUrl, "http://localhost").pathname;
  if (pathname !== docsBase && !pathname.startsWith(`${docsBase}/`)) {
    next();
    return;
  }

  if (pathname === docsBase) {
    res.statusCode = 302;
    res.setHeader("Location", `${docsBase}/`);
    res.end();
    return;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice(`${docsBase}/`.length));
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  let candidate = path.resolve(docsRoot, relativePath || "index.html");
  if (!candidate.startsWith(`${docsRoot}${path.sep}`) && candidate !== docsRoot) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    candidate = path.join(candidate, "index.html");
  } else if (!fs.existsSync(candidate) && !path.extname(candidate)) {
    candidate = path.join(candidate, "index.html");
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    const fallback404 = path.join(docsRoot, "404.html");
    if (fs.existsSync(fallback404)) {
      res.statusCode = 404;
      sendFile(fallback404, res);
      return;
    }
    next();
    return;
  }

  sendFile(candidate, res);
}

function docsStaticPlugin(): Plugin {
  const docsRoot = path.resolve(__dirname, "public/doc");

  return {
    name: "tensormesh-docs-static",
    configureServer(server) {
      server.middlewares.use((req, res, next) => serveDocsRequest(docsRoot, req.url, res, next));
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((req, res, next) => serveDocsRequest(docsRoot, req.url, res, next));
    }
  };
}

interface UploadSessionRegistry {
  version: 1;
  id: string;
  user: string;
  port: number;
  pid: number;
  secret: string;
  tokenHash: string;
  directory: string;
  createdAt: string;
  expiresAt: string;
}

function sendUploadJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

function loadUploadSession(id: string): UploadSessionRegistry {
  const registryPath = path.join(os.tmpdir(), `tensormesh-upload-${id}.json`);
  const stat = fs.statSync(registryPath);
  if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("invalid upload session registry");
  const record = JSON.parse(fs.readFileSync(registryPath, "utf8")) as UploadSessionRegistry;
  if (
    record.version !== 1
    || record.id !== id
    || !record.user
    || !Number.isInteger(record.port)
    || record.port < 1024
    || record.port > 65535
    || !record.secret
    || !/^[a-f0-9]{64}$/.test(record.tokenHash)
    || !record.directory
  ) {
    throw new Error("invalid upload session registry");
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) throw new Error("upload session has expired");
  return record;
}

function uploadToken(req: IncomingMessage, url: URL): string | undefined {
  const queryToken = url.searchParams.get("token") ?? url.searchParams.get("t");
  if (queryToken) return queryToken;
  const authorization = req.headers.authorization;
  return authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;
}

function uploadTokenMatches(record: UploadSessionRegistry, token: string | undefined): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(record.tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUploadSession(record: UploadSessionRegistry) {
  return {
    id: record.id,
    user: record.user,
    directory: record.directory,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    pid: record.pid
  };
}

function resolveUploadSession(token: string | undefined): UploadSessionRegistry | undefined {
  if (!token) return undefined;
  const records: UploadSessionRegistry[] = [];
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    const match = entry.isFile() && entry.name.match(/^tensormesh-upload-([a-f0-9]{24})\.json$/);
    if (!match) continue;
    try {
      const record = loadUploadSession(match[1]);
      if (uploadTokenMatches(record, token)) records.push(record);
    } catch {
      // Ignore malformed, stale, or expired registries while resolving a token.
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function proxyUpload(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  record: UploadSessionRegistry
) {
  const fileName = req.headers["x-tensormesh-file-name"];
  if (typeof fileName !== "string" || !fileName) {
    sendUploadJson(res, 400, { error: "missing_file_name", message: "缺少上传文件名" });
    return;
  }

  const headers: Record<string, string> = {
    "content-type": req.headers["content-type"] ?? "application/octet-stream",
    "x-tensormesh-file-name": fileName,
    "x-tensormesh-upload-secret": record.secret
  };
  if (typeof req.headers["content-length"] === "string") headers["content-length"] = req.headers["content-length"];

  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: record.port,
    path: "/upload",
    method: "POST",
    headers
  }, (upstreamResponse) => {
    res.statusCode = upstreamResponse.statusCode ?? 502;
    res.setHeader("Content-Type", upstreamResponse.headers["content-type"] ?? "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.on("close", () => {
      if (!res.writableEnded) upstreamResponse.destroy();
    });
    upstreamResponse.pipe(res);
  });
  upstream.setTimeout(proxyIdleTimeoutMs, () => upstream.destroy());
  const destroyUnfinishedUpload = () => {
    setImmediate(() => {
      if (!res.writableEnded && !res.destroyed) res.destroy();
    });
  };
  upstream.on("abort", destroyUnfinishedUpload);
  upstream.on("close", destroyUnfinishedUpload);
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      sendUploadJson(res, 502, { error: "upload_unavailable", message: `上传进程不可用：${error.message}` });
    } else {
      res.destroy(error);
    }
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

function uploadGatewayPlugin(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse<IncomingMessage>, next: MiddlewareNext) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/upload-api/resolve") {
      if (req.method !== "GET") {
        sendUploadJson(res, 405, { error: "method_not_allowed", message: "不支持该请求方法" });
        return;
      }
      const record = resolveUploadSession(uploadToken(req, url));
      if (!record) {
        sendUploadJson(res, 401, { error: "invalid_token", message: "上传 token 无效或会话已过期" });
        return;
      }
      sendUploadJson(res, 200, publicUploadSession(record));
      return;
    }

    const match = url.pathname.match(/^\/upload-api\/([a-f0-9]{24})(\/files)?$/);
    if (!match) {
      next();
      return;
    }

    let record: UploadSessionRegistry;
    try {
      record = loadUploadSession(match[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendUploadJson(res, message.includes("expired") ? 410 : 404, { error: "invalid_session", message });
      return;
    }
    if (!uploadTokenMatches(record, uploadToken(req, url))) {
      sendUploadJson(res, 401, { error: "invalid_token", message: "上传 token 无效" });
      return;
    }

    if (!match[2] && req.method === "GET") {
      sendUploadJson(res, 200, publicUploadSession(record));
      return;
    }
    if (match[2] && req.method === "POST") {
      proxyUpload(req, res, record);
      return;
    }
    sendUploadJson(res, 405, { error: "method_not_allowed", message: "不支持该请求方法" });
  };

  return {
    name: "tensormesh-upload-gateway",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(middleware);
    }
  };
}

function normalizeProxyPrefix(prefix: unknown, source: string): string {
  if (typeof prefix !== "string" || !prefix.trim()) {
    throw new Error(`Proxy registry entry in ${source} is missing prefix`);
  }
  const normalized = prefix.trim().replace(/\/+$/, "") || "/";
  if (normalized === "/") throw new Error(`Proxy registry entry in ${source} cannot use "/" as prefix`);
  if (!normalized.startsWith("/")) throw new Error(`Proxy prefix "${normalized}" in ${source} must start with "/"`);
  if (/[?#\s]/.test(normalized)) throw new Error(`Proxy prefix "${normalized}" in ${source} must not contain whitespace, query, or hash`);
  for (const reserved of ["/api", "/health", "/doc", "/tokens", "/upload", "/upload-api"]) {
    if (normalized === reserved || normalized.startsWith(`${reserved}/`)) {
      throw new Error(`Proxy prefix "${normalized}" in ${source} conflicts with TensorMesh route "${reserved}"`);
    }
  }
  return normalized;
}

function normalizeProxyTarget(target: unknown, source: string): string {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error(`Proxy registry entry in ${source} is missing target`);
  }
  const value = target.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Proxy target "${value}" in ${source} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Proxy target "${value}" in ${source} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Proxy target "${value}" in ${source} must not include credentials`);
  }
  return value.replace(/\/+$/, "");
}

function normalizeProxyRegistryEntry(entry: unknown, source: string): ProxyRegistryEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Proxy registry entry in ${source} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  let headers: Record<string, string> | undefined;
  if (record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)) {
    headers = {};
    for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  return {
    prefix: normalizeProxyPrefix(record.prefix, source),
    target: normalizeProxyTarget(record.target, source),
    changeOrigin: typeof record.changeOrigin === "boolean" ? record.changeOrigin : undefined,
    rewritePrefix: typeof record.rewritePrefix === "string" ? record.rewritePrefix : undefined,
    ws: typeof record.ws === "boolean" ? record.ws : undefined,
    secure: typeof record.secure === "boolean" ? record.secure : undefined,
    headers
  };
}

function registryEntriesFromJson(value: unknown, source: string): ProxyRegistryEntry[] {
  if (Array.isArray(value)) return value.map((entry) => normalizeProxyRegistryEntry(entry, source));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.proxies)) return record.proxies.map((entry) => normalizeProxyRegistryEntry(entry, source));
    return Object.entries(record).map(([prefix, target]) => normalizeProxyRegistryEntry({ prefix, target }, source));
  }
  throw new Error(`Proxy registry in ${source} must be a JSON array, object map, or { "proxies": [...] }`);
}

function registryEntriesFromText(text: string, source: string): ProxyRegistryEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return registryEntriesFromJson(JSON.parse(trimmed), source);
  }
  return trimmed
    .split(/[\n;,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error(`Proxy registry line "${line}" in ${source} must use prefix=target`);
      return normalizeProxyRegistryEntry({
        prefix: line.slice(0, separator),
        target: line.slice(separator + 1)
      }, source);
    });
}

function loadProxyRegistryEntries(): ProxyRegistryEntry[] {
  const entries: ProxyRegistryEntry[] = [];
  const userRegistryFile = process.env.HOME
    ? path.join(process.env.HOME, ".config/tensormesh/web-proxy-registry.json")
    : undefined;
  if (userRegistryFile && fs.existsSync(userRegistryFile)) {
    entries.push(...registryEntriesFromText(fs.readFileSync(userRegistryFile, "utf8"), userRegistryFile));
  }
  const registryFile = process.env.TENSORMESH_WEB_PROXY_REGISTRY_FILE?.trim();
  if (registryFile) {
    entries.push(...registryEntriesFromText(fs.readFileSync(registryFile, "utf8"), registryFile));
  }
  const registryText = process.env.TENSORMESH_WEB_PROXY_REGISTRY?.trim();
  if (registryText) {
    entries.push(...registryEntriesFromText(registryText, "TENSORMESH_WEB_PROXY_REGISTRY"));
  }
  return entries;
}

function proxyOption(entry: ProxyRegistryEntry, headers: Record<string, string> = {}): ProxyOptions {
  return {
    target: entry.target,
    changeOrigin: entry.changeOrigin ?? true,
    ws: entry.ws,
    secure: entry.secure,
    proxyTimeout: proxyIdleTimeoutMs,
    headers: {
      ...headers,
      ...entry.headers
    },
    rewrite: entry.rewritePrefix === undefined
      ? undefined
      : (requestPath) => `${entry.rewritePrefix}${requestPath.slice(entry.prefix.length)}`,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, _req, res) => {
        // An upstream request can be killed without an "error" event being
        // emitted (that is what proxyTimeout's abort() does). If it happens
        // while the response is still streaming, the client response would
        // otherwise hang forever: destroy it.
        const destroyUnfinishedResponse = () => {
          setImmediate(() => {
            if (!res.writableEnded && !res.destroyed) res.destroy();
          });
        };
        proxyReq.on("abort", destroyUnfinishedResponse);
        proxyReq.on("close", destroyUnfinishedResponse);
        // Free the upstream request connection if the client disconnects
        // before the response starts flowing.
        res.on("close", () => {
          if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
        });
      });
      // Backstop for upstream failures that do emit an "error" (e.g. ECONNRESET).
      proxy.on("error", (_error, _req, res) => {
        const response = res as unknown as ServerResponse | undefined;
        if (!response || typeof response.writableEnded !== "boolean") return; // ws upgrade socket
        if (response.headersSent && !response.writableEnded) response.destroy();
      });
    }
  };
}

function createProxyRegistry(): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {
    "/api": proxyOption({ prefix: "/api", target: "http://127.0.0.1:4317" }, { [webProxyHeader]: "1" }),
    "/health": proxyOption({ prefix: "/health", target: "http://127.0.0.1:4317" }, { [webProxyHeader]: "1" })
  };
  for (const entry of loadProxyRegistryEntries()) {
    if (proxy[entry.prefix]) throw new Error(`Duplicate proxy prefix "${entry.prefix}"`);
    proxy[entry.prefix] = proxyOption(entry, { [prefixProxyHeader]: "1" });
  }
  return proxy;
}

export default defineConfig({
  plugins: [uploadGatewayPlugin(), docsStaticPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.TENSORMESH_WEB_PORT ?? 8000),
    watch: {
      ignored: ["**/public/doc/**"]
    },
    proxy: createProxyRegistry()
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.TENSORMESH_WEB_PORT ?? 8000),
    proxy: createProxyRegistry()
  }
});
