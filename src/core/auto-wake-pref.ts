import { join } from "node:path";
import { isRecord, readJsonStore, writeJsonStore } from "./json-store.js";

/**
 * Auto-wake as the user last set it for a session (by peer name), so /reload-plugins or a restart of the
 * agent does not silently turn it off again. The config file's autoWake stays the default for new names.
 */
const FILE = "auto-wake.json";

function read(home: string): Record<string, unknown> {
  try {
    return (readJsonStore(join(home, FILE)) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function savedAutoWake(home: string, name: string): boolean | undefined {
  const data = read(home);
  const v = (isRecord(data.peers) ? data.peers : data)[name];
  return typeof v === "boolean" ? v : undefined;
}

export function saveAutoWake(home: string, name: string, enabled: boolean): void {
  try {
    const file = join(home, FILE);
    const previous = readJsonStore(file);
    const data = isRecord(previous) ? previous : {};
    const peers = isRecord(data.peers) ? data.peers : data;
    writeJsonStore(file, { ...data, peers: { ...peers, [name]: enabled } }, previous);
  } catch (err) {
    process.stderr.write(`could not save auto-wake preference: ${String(err)}\n`);
    // best effort: the setting still applies to this session
  }
}
