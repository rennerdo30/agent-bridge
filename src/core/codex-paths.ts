import { realpath } from "node:fs/promises";
import { cachedExecutionDriveMappings, discoverDriveAliases, displayPath, displayPathText, pathDisplayPrefersAlias, refreshDriveAliases, resolveExecutionDriveRoots, type CanonicalPath, type DriveMapping } from "./display-paths.js";
export type { DriveMapping } from "./display-paths.js";

function uniqueMappings(mappings: readonly DriveMapping[]): DriveMapping[] {
  return [...new Map(mappings.filter((m) => m.alias.toLowerCase() !== m.real.toLowerCase()).map((m) => [m.alias.toLowerCase(), m])).values()];
}

function displayMapping(mapping: DriveMapping): string {
  const alias = displayPath(mapping.alias), real = displayPath(mapping.real);
  return real === alias ? `preferred ${alias} (verified drive alias)` : `${alias} (same location as ${real})`;
}

/** Report paths only read the cached snapshot and may trigger a background refresh. */
export function codexDriveMappings(text: string, platform: string = process.platform, canonical: CanonicalPath = realpath): DriveMapping[] {
  if (platform !== "win32") return [];
  const drives = new Set([...text.matchAll(/\b([a-z]):[\\/]/gi)].map((m) => `${m[1]!.toUpperCase()}:\\`));
  if (!drives.size) return [];
  const mappings = discoverDriveAliases(platform, canonical).filter((m) => drives.has(m.alias) || drives.has(m.real));
  for (const mapping of cachedExecutionDriveMappings(platform, canonical)) {
    if (drives.has(mapping.alias) && !mappings.some((m) => m.alias === mapping.alias)) mappings.push(mapping);
  }
  return mappings;
}

/** Native startup awaits bounded asynchronous probes; it never runs on a display path. */
export async function resolveCodexDriveMappings(text: string, platform: string = process.platform, canonical: CanonicalPath = realpath): Promise<DriveMapping[]> {
  if (platform !== "win32") return [];
  const roots = [...new Set([...text.matchAll(/\b([a-z]):[\\/]/gi)].map((match) => `${match[1]!.toUpperCase()}:\\`))];
  if (!roots.length) return [];
  await refreshDriveAliases(platform, canonical);
  // An in-flight scan may have started before a new subst was created. Recheck
  // requested roots after it settles instead of sharing that earlier result.
  const requested = await resolveExecutionDriveRoots(roots, platform, canonical);
  return [...codexDriveMappings(text, platform, canonical).filter((mapping) => !roots.includes(mapping.alias)), ...requested];
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
