import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Auto-wake as the user last set it for a session (by peer name), so /reload-plugins or a restart of the
 * agent does not silently turn it off again. The config file's autoWake stays the default for new names.
 */
const FILE = "auto-wake.json";

function read(home: string): Record<string, boolean> {
  try {
    const data = JSON.parse(readFileSync(join(home, FILE), "utf8")) as unknown;
    return data && typeof data === "object" ? (data as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function savedAutoWake(home: string, name: string): boolean | undefined {
  const v = read(home)[name];
  return typeof v === "boolean" ? v : undefined;
}

export function saveAutoWake(home: string, name: string, enabled: boolean): void {
  try {
    const all = { ...read(home), [name]: enabled };
    const file = join(home, FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    // best effort: the setting still applies to this session
  }
}
