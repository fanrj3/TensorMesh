import {cp, mkdir, rm, stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsBuild = path.join(repoRoot, "apps/docs/build");
const webDocs = path.join(repoRoot, "apps/web/public/doc");

async function ensureBuiltDocs() {
  const indexPath = path.join(docsBuild, "index.html");
  try {
    const info = await stat(indexPath);
    if (info.isFile()) return;
  } catch {
    // Handled below with a clearer message.
  }

  throw new Error("Missing apps/docs/build/index.html. Run npm run build:docs first.");
}

await ensureBuiltDocs();
await rm(webDocs, {recursive: true, force: true});
await mkdir(webDocs, {recursive: true});
await cp(docsBuild, webDocs, {recursive: true});

console.log(`Synced ${path.relative(repoRoot, docsBuild)} -> ${path.relative(repoRoot, webDocs)}`);
