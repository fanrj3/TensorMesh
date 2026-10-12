import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const defaultSecretPath = path.join(repoRoot, "data", "web-token-secret");
const defaultUserSecretDir = path.join(repoRoot, "data", "web-token-users");

export interface WebTokenPayload {
  user: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

function base64urlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeUserName(user: string): string {
  return user.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function currentUserName(): string {
  return process.env.USER || process.env.LOGNAME || os.userInfo().username || "unknown";
}

async function readSecretFile(secretPath: string): Promise<string | null> {
  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    return existing || null;
  } catch {
    return null;
  }
}

async function getOrCreateSecretFile(secretPath: string, options: { directoryMode?: number; hardenDirectory?: boolean } = {}): Promise<string> {
  const existing = await readSecretFile(secretPath);
  if (existing) return existing;

  const nextSecret = randomBytes(32).toString("base64url");
  const secretDir = path.dirname(secretPath);
  const directoryMode = options.directoryMode ?? 0o700;
  await mkdir(secretDir, { recursive: true, mode: directoryMode });
  if (options.hardenDirectory) {
    await chmod(secretDir, directoryMode).catch(() => undefined);
  }
  try {
    await writeFile(secretPath, `${nextSecret}\n`, { mode: 0o600, flag: "wx" });
    return nextSecret;
  } catch {
    const afterRace = await readSecretFile(secretPath);
    if (afterRace) return afterRace;
    throw new Error(`Unable to initialize TensorMesh web token secret at ${secretPath}`);
  }
}

async function lookupUserHome(user: string): Promise<string | null> {
  try {
    const passwd = await readFile("/etc/passwd", "utf8");
    const row = passwd
      .split("\n")
      .find((line) => line.split(":")[0] === user);
    const home = row?.split(":")[5];
    return home || null;
  } catch {
    return null;
  }
}

async function defaultUserSecretPath(user: string, mode: "create" | "verify"): Promise<string> {
  const configuredDir = process.env.TENSORMESH_WEB_TOKEN_USER_SECRET_DIR?.trim();
  if (configuredDir) return path.join(configuredDir, `${safeUserName(user)}.secret`);

  if (mode === "create") return path.join(os.homedir(), ".tensormesh", "web-token-secret");

  const home = await lookupUserHome(user);
  return path.join(home ?? path.join("/home", safeUserName(user)), ".tensormesh", "web-token-secret");
}

async function getWebTokenSecret(user: string, mode: "create" | "verify"): Promise<string | null> {
  const envSecret = process.env.TENSORMESH_WEB_TOKEN_SECRET?.trim();
  if (envSecret) return envSecret;

  const explicitSecretPath = process.env.TENSORMESH_WEB_TOKEN_SECRET_FILE?.trim();
  if (explicitSecretPath) {
    return mode === "create" ? getOrCreateSecretFile(explicitSecretPath) : readSecretFile(explicitSecretPath);
  }

  const userSecretPath = await defaultUserSecretPath(user, mode);
  if (mode === "create") {
    return getOrCreateSecretFile(userSecretPath, { hardenDirectory: !process.env.TENSORMESH_WEB_TOKEN_USER_SECRET_DIR?.trim() });
  }

  const userSecret = await readSecretFile(userSecretPath);
  if (userSecret) return userSecret;

  const legacyUserSecret = await readSecretFile(path.join(defaultUserSecretDir, `${safeUserName(user)}.secret`));
  if (legacyUserSecret) return legacyUserSecret;

  return readSecretFile(defaultSecretPath);
}

async function signPayload(payloadEncoded: string, user: string, mode: "create" | "verify"): Promise<string | null> {
  const secret = await getWebTokenSecret(user, mode);
  if (!secret) return null;
  return createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
}

function decodePayload(token: string): { payloadEncoded: string; signature: string; payload: WebTokenPayload } | null {
  const [payloadEncoded, signature] = token.split(".");
  if (!payloadEncoded || !signature) return null;

  try {
    const payload = JSON.parse(base64urlDecode(payloadEncoded)) as WebTokenPayload;
    return { payloadEncoded, signature, payload };
  } catch {
    return null;
  }
}

function signatureMatches(signature: string, expected: string): boolean {
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return signatureBuffer.length === expectedBuffer.length && timingSafeEqual(signatureBuffer, expectedBuffer);
}

export async function createWebToken(input: { user: string; ttlSeconds?: number; now?: Date }): Promise<string> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? 12 * 60 * 60;
  const payload: WebTokenPayload = {
    user: input.user,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    nonce: randomBytes(12).toString("base64url")
  };
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signature = await signPayload(payloadEncoded, payload.user, "create");
  if (!signature) throw new Error("Unable to initialize TensorMesh web token secret");
  return `${payloadEncoded}.${signature}`;
}

export async function verifyWebToken(token: string | undefined | null, now = new Date()): Promise<WebTokenPayload | null> {
  if (!token) return null;
  const decoded = decodePayload(token);
  if (!decoded) return null;

  const expected = await signPayload(decoded.payloadEncoded, decoded.payload.user, "verify");
  if (!expected || !signatureMatches(decoded.signature, expected)) return null;

  const payload = decoded.payload;
  if (!payload.user || !payload.expiresAt) return null;
  if (new Date(payload.expiresAt).getTime() <= now.getTime()) return null;
  return payload;
}

export function getWebTokenSecretPath(user = currentUserName()): string {
  if (process.env.TENSORMESH_WEB_TOKEN_SECRET?.trim()) return "TENSORMESH_WEB_TOKEN_SECRET";
  const configuredDir = process.env.TENSORMESH_WEB_TOKEN_USER_SECRET_DIR?.trim();
  if (configuredDir) return path.join(configuredDir, `${safeUserName(user)}.secret`);
  return process.env.TENSORMESH_WEB_TOKEN_SECRET_FILE?.trim() || path.join(os.homedir(), ".tensormesh", "web-token-secret");
}
