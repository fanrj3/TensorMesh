import { timingSafeEqual } from "node:crypto";
import { constants as fsConstants, unlinkSync } from "node:fs";
import { access, mkdir, open, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const sessionId = requiredEnv("TENSORMESH_UPLOAD_SESSION_ID");
const sessionSecret = requiredEnv("TENSORMESH_UPLOAD_SESSION_SECRET");
const sessionUser = requiredEnv("TENSORMESH_UPLOAD_SESSION_USER");
const tokenHash = requiredEnv("TENSORMESH_UPLOAD_TOKEN_HASH");
const registryPath = requiredEnv("TENSORMESH_UPLOAD_REGISTRY_PATH");
const requestedDirectory = requiredEnv("TENSORMESH_UPLOAD_DIRECTORY");
const expiresAt = requiredEnv("TENSORMESH_UPLOAD_EXPIRES_AT");
const maxBytes = Number(process.env.TENSORMESH_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024 * 1024);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sendJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(payload)));
  response.setHeader("cache-control", "no-store");
  response.end(payload);
}

function secretMatches(request: IncomingMessage): boolean {
  const candidate = request.headers["x-tensormesh-upload-secret"];
  if (typeof candidate !== "string") return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(sessionSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestedFileName(request: IncomingMessage): string {
  const header = request.headers["x-tensormesh-file-name"];
  const encoded = Array.isArray(header) ? header[0] : header;
  if (!encoded) throw new Error("missing upload file name");

  let fileName: string;
  try {
    fileName = decodeURIComponent(encoded).normalize("NFC");
  } catch {
    throw new Error("invalid upload file name encoding");
  }

  if (!fileName || fileName === "." || fileName === ".." || /[\\/\0]/.test(fileName)) {
    throw new Error("invalid upload file name");
  }
  if (Buffer.byteLength(fileName, "utf8") > 240) {
    throw new Error("upload file name is too long");
  }
  return fileName;
}

async function createUniqueFile(directory: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? fileName : `${stem} (${index})${extension}`;
    const filePath = path.join(directory, candidate);
    try {
      return {
        fileName: candidate,
        filePath,
        handle: await open(filePath, "wx", 0o600)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("too many files share this name");
}

async function receiveFile(request: IncomingMessage, response: ServerResponse<IncomingMessage>, directory: string) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(maxBytes) && maxBytes > 0 && contentLength > maxBytes) {
    sendJson(response, 413, { error: "too_large", message: "文件超过上传大小限制" });
    return;
  }

  let upload: Awaited<ReturnType<typeof createUniqueFile>> | undefined;
  try {
    upload = await createUniqueFile(directory, requestedFileName(request));
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (Number.isFinite(maxBytes) && maxBytes > 0 && receivedBytes > maxBytes) {
          callback(new Error("file exceeds upload size limit"));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(request, limiter, upload.handle.createWriteStream());
    sendJson(response, 201, {
      ok: true,
      name: upload.fileName,
      size: receivedBytes,
      user: sessionUser
    });
  } catch (error) {
    if (upload) await unlink(upload.filePath).catch(() => undefined);
    sendJson(response, 400, {
      error: "upload_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function main() {
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(requestedDirectory);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error(`${directory} is not a directory`);
  await access(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);

  const expiryTime = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) throw new Error("upload session is already expired");

  const server = createServer((request, response) => {
    if (!secretMatches(request)) {
      sendJson(response, 401, { error: "unauthorized", message: "invalid upload gateway secret" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        sessionId,
        user: sessionUser,
        directory,
        expiresAt,
        pid: process.pid
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/upload") {
      void receiveFile(request, response, directory);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("upload server did not receive a TCP port");
    void writeFile(registryPath, `${JSON.stringify({
      version: 1,
      id: sessionId,
      user: sessionUser,
      port: address.port,
      pid: process.pid,
      secret: sessionSecret,
      tokenHash,
      directory,
      createdAt: new Date().toISOString(),
      expiresAt
    })}\n`, { mode: 0o644, flag: "wx" })
      .then(() => {
        process.send?.({
          ready: true,
          sessionId,
          port: address.port,
          pid: process.pid,
          directory,
          expiresAt
        });
      })
      .catch((error) => {
        process.send?.({ ready: false, error: error instanceof Error ? error.message : String(error) });
        server.close(() => process.exit(1));
      });
  });

  const remainingMs = Math.max(1, expiryTime - Date.now());
  const expiryTimer = setTimeout(() => server.close(() => process.exit(0)), remainingMs);
  expiryTimer.unref();

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", () => {
    try {
      unlinkSync(registryPath);
    } catch {
      // The registry may already have been cleaned up.
    }
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.send?.({ ready: false, error: message });
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
