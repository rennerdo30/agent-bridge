import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/display-paths.ts
import { realpathSync } from "node:fs";
var plain = (path) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
function displayDrive(platform, canonical) {
  if (platform !== "win32") return null;
  try {
    const root = plain(canonical("E:\\")).replace(/\//g, "\\").replace(/\\*$/, "\\");
    if (!/^[a-z]:\\$/i.test(root) || /^e:/i.test(root)) return null;
    const physical = plain(canonical(root)).replace(/\//g, "\\").replace(/\\*$/, "\\");
    return physical.toLowerCase() === root.toLowerCase() ? root[0] : null;
  } catch {
    return null;
  }
}
function displayPath(path, platform = process.platform, canonical = realpathSync.native) {
  const drive = displayDrive(platform, canonical), value = plain(path);
  return drive && value.slice(0, 2).toLowerCase() === `${drive}:`.toLowerCase() && /^[a-z]:[\\/]/i.test(value) ? `E:${value.slice(2)}` : path;
}
function displayPathText(text, platform = process.platform, canonical = realpathSync.native) {
  const drive = displayDrive(platform, canonical);
  if (!drive) return text;
  return text.replace(new RegExp(`(^|[^\\w])(?:\\\\\\\\\\?\\\\)?${drive}:([\\\\/])`, "gi"), "$1E:$2");
}

export {
  displayPath,
  displayPathText
};
