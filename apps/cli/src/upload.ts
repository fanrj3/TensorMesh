import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentUser } from "@tensormesh/shared/node";

interface UploadReadyMessage {
  ready: boolean;
  error?: string;
  sessionId?: string;
  port?: number;
  pid?: number;
  directory?: string;
  expiresAt?: string;
}

function getFlag(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function expandDirectory(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function waitForReady(child: ChildProcess): Promise<Required<Pick<UploadReadyMessage, "port" | "pid" | "directory" | "expiresAt">>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upload server did not become ready within 10 seconds")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`upload server exited before startup (code ${code ?? "unknown"})`));
    };
    const onMessage = (raw: unknown) => {
      const message = raw as UploadReadyMessage;
      if (!message?.ready) {
        cleanup();
        reject(new Error(message?.error ?? "upload server failed to start"));
        return;
      }
      if (!message.port || !message.pid || !message.directory || !message.expiresAt) return;
      cleanup();
      resolve({
        port: message.port,
        pid: message.pid,
        directory: message.directory,
        expiresAt: message.expiresAt
      });
    };
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function printUploadHelp() {
  process.stdout.write(`TensorMesh temporary upload\n\nUsage:\n  tmesh upload [DIRECTORY] [--ttl HOURS]\n\nExamples:\n  tmesh upload ~/uploads\n  tmesh upload /data/alice/inbox --ttl 2\n\nThe default directory is the current working directory. The default lifetime is 6 hours.\n`);
}

export async function runUploadCommand(args: string[], options: { webBaseUrl: string }): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printUploadHelp();
    return;
  }

  const directoryArg = args[0] && !args[0].startsWith("-") ? args[0] : process.cwd();
  const directory = expandDirectory(directoryArg);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const requestedTtl = Number(getFlag(args, "--ttl", "6"));
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0 || requestedTtl > 168) {
    throw new Error("--ttl must be greater than 0 and no more than 168 hours");
  }
  const ttlSeconds = Math.max(60, Math.round(requestedTtl * 3600));
  const user = getCurrentUser();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const sessionId = randomBytes(12).toString("hex");
  const sessionSecret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const registryPath = path.join(os.tmpdir(), `tensormesh-upload-${sessionId}.json`);

  const stateDirectory = path.join(os.homedir(), ".tensormesh", "uploads");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDirectory, `${sessionId}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const uploadServerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "upload-server.ts");
  const child = spawn(process.execPath, [...process.execArgv, uploadServerPath], {
    detached: true,
    env: {
      ...process.env,
      TENSORMESH_UPLOAD_SESSION_ID: sessionId,
      TENSORMESH_UPLOAD_SESSION_SECRET: sessionSecret,
      TENSORMESH_UPLOAD_SESSION_USER: user,
      TENSORMESH_UPLOAD_TOKEN_HASH: tokenHash,
      TENSORMESH_UPLOAD_REGISTRY_PATH: registryPath,
      TENSORMESH_UPLOAD_DIRECTORY: directory,
      TENSORMESH_UPLOAD_EXPIRES_AT: expiresAt
    },
    stdio: ["ignore", logFd, logFd, "ipc"]
  });
  closeSync(logFd);

  try {
    const ready = await waitForReady(child);
    child.disconnect();
    child.unref();

    const uploadUrl = `${options.webBaseUrl.replace(/\/+$/, "")}/upload/${sessionId}?token=${encodeURIComponent(token)}`;
    process.stdout.write(`TensorMesh Upload for ${user}\n`);
    process.stdout.write(`Directory: ${ready.directory}\n`);
    process.stdout.write(`Expires:   ${new Date(ready.expiresAt).toLocaleString()} (${Math.round(ttlSeconds / 360) / 10}h)\n`);
    process.stdout.write(`URL:       ${uploadUrl}\n`);
    process.stdout.write(`Token:     ${token}\n`);
    process.stdout.write(`Log:       ${logPath}\n`);
  } catch (error) {
    if (child.connected) child.disconnect();
    child.kill("SIGTERM");
    throw error;
  }
}
