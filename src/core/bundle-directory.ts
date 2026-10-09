import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export function bundleDirectory(url: string): string {
 const dir = dirname(fileURLToPath(url));
 return basename(dir) === "chunks" ? dirname(dir) : dir;
}
