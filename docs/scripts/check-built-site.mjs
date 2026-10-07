// Verify that same-origin links and assets in the generated static site stay
// inside the configured Pages base path and resolve to generated files.

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const outputRoot = resolve("dist");
const requestedBase = process.argv[2] || "/";
const base = `/${requestedBase.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const origin = "https://pages.invalid";

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function publicRoute(file) {
  const local = relative(outputRoot, file).split(sep).join("/");
  if (local === "index.html") return base;
  if (local.endsWith("/index.html")) return `${base}${local.slice(0, -"index.html".length)}`;
  return `${base}${local}`;
}

function localCandidates(pathname) {
  const withoutBase = decodeURIComponent(pathname.slice(base.length));
  const direct = join(outputRoot, ...withoutBase.split("/").filter(Boolean));
  if (!withoutBase || pathname.endsWith("/")) return [join(direct, "index.html")];
  if (extname(direct)) return [direct];
  return [direct, `${direct}.html`, join(direct, "index.html")];
}

const failures = [];
const htmlFiles = (await filesBelow(outputRoot)).filter((file) => file.endsWith(".html"));
const pages = new Map(await Promise.all(htmlFiles.map(async file => [file, await readFile(file, "utf8")])));

for (const file of htmlFiles) {
  const html = pages.get(file);
  const pageUrl = new URL(publicRoute(file), origin);
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(?:mailto:|tel:|data:|javascript:)/i.test(value)) continue;

    const target = new URL(value, pageUrl);
    if (target.origin !== origin) continue;
    if (!target.pathname.startsWith(base)) {
      failures.push(`${relative(outputRoot, file)} escapes ${base}: ${value}`);
      continue;
    }

    const candidates = localCandidates(target.pathname);
    const found = candidates.find(path => pages.has(path)) || (await Promise.all(candidates.map(exists))).some(Boolean);
    if (!found) {
      failures.push(`${relative(outputRoot, file)} has missing target: ${value}`);
    } else if (target.hash && typeof found === "string") {
      const id = decodeURIComponent(target.hash.slice(1));
      const destination = pages.get(found);
      if (!destination.includes(`id="${id}"`)) failures.push(`${relative(outputRoot, file)} has missing anchor: ${value}`);
    }
  }
}

if (failures.length) {
  console.error(`Built-site check failed with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Built-site check passed for ${htmlFiles.length} HTML file(s) under ${base}`);
}
