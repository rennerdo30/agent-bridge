import { realpathSync } from "node:fs";
import { discoverDriveAliases, displayPath, displayPathText, pathDisplayPrefersAlias, type DriveMapping } from "./display-paths.js";
export type { DriveMapping } from "./display-paths.js";

function uniqueMappings(mappings: readonly DriveMapping[]): DriveMapping[] {
  return [...new Map(mappings.filter((m) => m.alias.toLowerCase() !== m.real.toLowerCase()).map((m) => [m.alias.toLowerCase(), m])).values()];
}

function displayMapping(mapping: DriveMapping): string {
  const alias = displayPath(mapping.alias), real = displayPath(mapping.real);
  return real === alias ? `preferred ${alias} (verified drive alias)` : `${alias} (same location as ${real})`;
}

/** Resolve drive roots in the supervisor's logon session, before Codex switches sandbox users. */
export function codexDriveMappings(text: string, platform: string = process.platform, canonical: (path: string) => string = realpathSync.native): DriveMapping[] {
  if (platform !== "win32") return [];
  const drives = new Set([...text.matchAll(/\b([a-z]):[\\/]/gi)].map((m) => `${m[1]!.toUpperCase()}:\\`));
  const mappings = discoverDriveAliases(platform, canonical).filter((m) => drives.has(m.alias) || drives.has(m.real));
  for (const alias of drives) {
    if (mappings.some((m) => m.alias === alias || m.real === alias)) continue;
    try {
      const real = canonical(alias).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/[\\/]*$/, "\\");
      if (real.toLowerCase() !== alias.toLowerCase()) mappings.push({ alias, real });
    } catch { /* A missing drive is not evidence of an alias. */ }
  }
  return mappings;
}

/** Translate paths even when their final file does not exist yet. */
export function codexPathPrompt(prompt: string, mappings: readonly DriveMapping[], preferDisplay = false): string {
  // Remove our own previous notes before translating: nested/continued prompts must
  // not rewrite an alias equation into a physical-drive self-equation.
  let text = prompt.replace(/\n*\(agent-bridge: Windows drive aliases resolved by the supervisor:[^\r\n]*\)/g, "")
    .replace(/(?:^|\n)Windows path mappings \(same folders\):[^\r\n]*/g, "");
  const unique = uniqueMappings(mappings);
  if (unique.length || text !== prompt) text = text.trimEnd();
  if (preferDisplay) text = displayPathText(text);
  else for (const { alias, real } of unique) {
    const drive = alias[0]!;
    text = text.replace(new RegExp(`\\b${drive}:[\\\\/]`, "gi"), () => real);
  }
  if (!unique.length) return text;
  const paths = unique.map((m) => preferDisplay ? displayMapping(m) : `${m.alias} (physical drive ${m.real})`).join(", ");
  const instruction = preferDisplay
    ? pathDisplayPrefersAlias() ? "Use verified alias spellings in commands and reports." : "Alias display preference is disabled; keep the supplied path spelling."
    : "Use physical paths for sandbox commands; reports follow the path display preference.";
  return `${text}\n\n(agent-bridge: Windows drive aliases resolved by the supervisor: ${paths}. These are the same folders. ${instruction} Proceed without requesting path confirmation.)`;
}

export function codexPathReport(mappings: readonly DriveMapping[]): string | null {
  const unique = uniqueMappings(mappings);
  return unique.length ? `Windows path mappings (same folders): ${unique.map(displayMapping).join(", ")}. ${pathDisplayPrefersAlias() ? "Prefer verified alias spellings in reports" : "Alias display preference is disabled"}; physical paths remain valid for sandbox execution.` : null;
}
