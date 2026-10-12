import fs from "node:fs";
import path from "node:path";

const buildDir = path.resolve("build");
const textExtensions = new Set([".html", ".xml"]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name))) continue;

    const buffer = fs.readFileSync(fullPath);
    if (!buffer.includes(0)) continue;
    fs.writeFileSync(fullPath, Buffer.from(buffer.filter((byte) => byte !== 0)));
  }
}

if (fs.existsSync(buildDir)) {
  walk(buildDir);
}
