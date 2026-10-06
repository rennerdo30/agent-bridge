import { realpathSync } from "node:fs";

export interface DriveMapping {
  alias: string;
  real: string;
}

/** Resolve drive roots in the supervisor's logon session, before Codex switches sandbox users. */
export function codexDriveMappings(text: string, platform: string = process.platform, canonical: (path: string) => string = realpathSync.native): DriveMapping[] {
  if (platform !== "win32") return [];
  const drives = new Set([...text.matchAll(/\b([a-z]):[\\/]/gi)].map((m) => `${m[1]!.toUpperCase()}:\\`));
  const mappings: DriveMapping[] = [];
  for (const alias of drives) {
    try {
      const real = canonical(alias).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/[\\/]*$/, "\\");
      if (real.toLowerCase() !== alias.toLowerCase()) mappings.push({ alias, real });
    } catch { /* A missing drive is not evidence of an alias. */ }
  }
  return mappings;
}

/** Translate paths even when their final file does not exist yet. */
export function codexPathPrompt(prompt: string, mappings: readonly DriveMapping[]): string {
  let text = prompt;
  for (const { alias, real } of mappings) {
    const drive = alias[0]!;
    text = text.replace(new RegExp(`\\b${drive}:[\\\\/]`, "gi"), () => real);
  }
  if (!mappings.length) return text;
  return `${text}\n\n(agent-bridge: Windows drive aliases resolved by the supervisor: ${mappings.map((m) => `${m.alias} = ${m.real}`).join(", ")}. These are the same folders. Use the real paths supplied above, including for new output files, without requesting path confirmation. In your report name both the requested alias and the real path.)`;
}

export function codexPathReport(mappings: readonly DriveMapping[]): string | null {
  return mappings.length ? `Windows path mappings (same folders): ${mappings.map((m) => `${m.alias} = ${m.real}`).join(", ")}. Outputs using the real paths are also available through these supervisor aliases.` : null;
}
