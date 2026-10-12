import { realpathSync } from "node:fs";

type CanonicalPath = (path: string) => string;
const plain = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");

/** Prefer the owner's whole-drive E: alias only while its physical mapping is verified.
 * This is presentation only: never use it for identity, containment or sandbox admission.
 */
function displayDrive(platform: string, canonical: CanonicalPath): string | null {
  if (platform !== "win32") return null;
  try {
    const root = plain(canonical("E:\\")).replace(/\//g, "\\").replace(/\\*$/, "\\");
    if (!/^[a-z]:\\$/i.test(root) || /^e:/i.test(root)) return null;
    const physical = plain(canonical(root)).replace(/\//g, "\\").replace(/\\*$/, "\\");
    return physical.toLowerCase() === root.toLowerCase() ? root[0]! : null;
  } catch { return null; }
}

export function displayPath(path: string, platform = process.platform, canonical: CanonicalPath = realpathSync.native): string {
  const drive = displayDrive(platform, canonical), value = plain(path);
  return drive && value.slice(0, 2).toLowerCase() === `${drive}:`.toLowerCase() && /^[a-z]:[\\/]/i.test(value)
    ? `E:${value.slice(2)}` : path;
}

/** Format embedded absolute paths in diagnostics without changing stored records. */
export function displayPathText(text: string, platform = process.platform, canonical: CanonicalPath = realpathSync.native): string {
  const drive = displayDrive(platform, canonical);
  if (!drive) return text;
  return text.replace(new RegExp(`(^|[^\\w])(?:\\\\\\\\\\?\\\\)?${drive}:([\\\\/])`, "gi"), "$1E:$2");
}
