import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/bundle-directory.ts
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function bundleDirectory(url) {
  const dir = dirname(fileURLToPath(url));
  return basename(dir) === "chunks" ? dirname(dir) : dir;
}

export {
  bundleDirectory
};
