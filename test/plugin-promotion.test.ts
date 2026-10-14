import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_PROMOTION_MAX_ATTEMPTS, PLUGIN_PROMOTION_RETRY_DELAY_MS, publishPlugin, runtimeRoot, selectRuntime, type PluginClient } from "../src/core/plugin-runtime.js";
import { runInstaller } from "../src/cli/installer.js";
import * as delegate from "../src/core/delegate.js";
import * as antigravity from "../src/cli/antigravity-install.js";
import * as sources from "../src/cli/opencode-install.js";
import * as liveUpdate from "../src/cli/live-update.js";
import { APP_VERSION } from "../src/core/constants.js";

let root: string, source: string;
const clients: PluginClient[] = ["antigravity", "claude", "codex"];
const errno = (code: string) => Object.assign(new Error(`${code}: injected rename failure`), { code });
const payload = (dir: string) => readFileSync(join(dir, "dist", "worker.mjs"), "utf8");
const stages = (base: string) => readdirSync(join(base, "..")).filter(name => name.startsWith(".agent-bridge-stage-"));
function captureFailure(action: () => unknown): Error {
  try { action(); } catch (error) { return error as Error; }
  throw new Error("Expected publication to fail");
}
function expectDiagnostic(error: Error, stage: string, target: string): void {
  for (const text of [stage, target, "No runtime was activated by this publication", "active.json was not changed by it", "Old version bytes are retained", "stage is kept", "Antigravity/agy/Claude/Codex", "before re-running"]) expect(error.message).toContain(text);
  expect(error.message).not.toContain("previous install is unchanged");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ab-promotion-"));
  source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "dist", "worker.mjs"), "new plugin payload");
});
// Keep temporary fixture stages as well as production stages; never touch installed caches.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function previous(client: PluginClient) {
  const home = join(root, "runtime"), oldSource = join(root, "old-source");
  mkdirSync(join(oldSource, "dist"), { recursive: true });
  writeFileSync(join(oldSource, "dist", "worker.mjs"), "old plugin payload");
  selectRuntime(home, client, oldSource, "0.1.0");
  const base = runtimeRoot(home, client), selector = join(base, "active.json");
  return { home, base, selector, before: readFileSync(selector, "utf8") };
}

describe("shared immutable plugin promotion", () => {
  it.each(clients)("retries a transient Windows EPERM for %s before activating", (client) => {
    const { home, base, selector, before } = previous(client);
    const seenStages: string[] = [], waits: number[] = [];
    const rename = vi.fn((stage: string, target: string) => {
      seenStages.push(stage);
      expect(readFileSync(selector, "utf8")).toBe(before);
      if (seenStages.length === 1) throw errno("EPERM");
      renameSync(stage, target);
    });
    const target = selectRuntime(home, client, source, "0.1.1", {
      platform: "win32", rename, sleep: ms => { waits.push(ms); expect(readFileSync(selector, "utf8")).toBe(before); },
    });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(new Set(seenStages).size).toBe(1);
    expect(waits).toEqual([PLUGIN_PROMOTION_RETRY_DELAY_MS]);
    expect(payload(target)).toBe("new plugin payload");
    expect(JSON.parse(readFileSync(selector, "utf8")).version).toBe("0.1.1");
    expect(payload(join(base, "0.1.0"))).toBe("old plugin payload");
  });

  it.each(clients)("keeps the stage and prior activation after persistent Windows EPERM for %s", (client) => {
    const { home, base, selector, before } = previous(client);
    const failure = errno("EPERM"), waits: number[] = [];
    let retained = "";
    const rename = vi.fn((stage: string) => { retained = stage; throw failure; });
    let thrown: unknown;
    try { selectRuntime(home, client, source, "0.1.1", { platform: "win32", rename, sleep: ms => waits.push(ms) }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expectDiagnostic(thrown as Error, retained, join(base, "0.1.1"));
    expect(message).toContain("EPERM");
    expect((thrown as Error).cause).toBe(failure);
    expect(rename).toHaveBeenCalledTimes(PLUGIN_PROMOTION_MAX_ATTEMPTS);
    expect(waits).toEqual([50, 100, 150, 200]);
    expect(stages(base)).toHaveLength(1);
    expect(payload(retained)).toBe("new plugin payload");
    expect(existsSync(join(base, "0.1.1"))).toBe(false);
    expect(readFileSync(selector, "utf8")).toBe(before);
    expect(payload(join(base, "0.1.0"))).toBe("old plugin payload");
  });

  it("reconciles an identical target after the final error using the retained stage digest", () => {
    const { home, base, selector } = previous("antigravity");
    let retained = "", calls = 0;
    const target = selectRuntime(home, "antigravity", source, "0.1.1", {
      platform: "win32", sleep: () => {}, rename: (stage, destination) => {
        retained = stage;
        if (++calls === PLUGIN_PROMOTION_MAX_ATTEMPTS) {
          cpSync(stage, destination, { recursive: true });
          writeFileSync(join(source, "dist", "worker.mjs"), "source changed after staging");
        }
        throw errno("EPERM");
      },
    });
    expect(calls).toBe(PLUGIN_PROMOTION_MAX_ATTEMPTS);
    expect(payload(target)).toBe("new plugin payload");
    expect(payload(retained)).toBe("new plugin payload");
    expect(stages(base)).toHaveLength(1);
    expect(JSON.parse(readFileSync(selector, "utf8")).version).toBe("0.1.1");
  });

  it("preserves a differing concurrent target and does not activate or retry over it", () => {
    const { home, base, selector, before } = previous("claude");
    const rename = vi.fn((_stage: string, target: string) => {
      mkdirSync(join(target, "dist"), { recursive: true });
      writeFileSync(join(target, "dist", "worker.mjs"), "concurrent different payload");
      throw errno("EPERM");
    });
    const sleep = vi.fn();
    const error = captureFailure(() => selectRuntime(home, "claude", source, "0.1.1", { platform: "win32", rename, sleep }));
    expect(error.message).toContain("content conflict");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(payload(join(base, "0.1.1"))).toBe("concurrent different payload");
    expect(payload(join(base, "..", stages(base)[0]!))).toBe("new plugin payload");
    expect(readFileSync(selector, "utf8")).toBe(before);
  });

  it("reports a content conflict that appears inside the backoff sleep with the original rename cause", () => {
    const { home, base, selector, before } = previous("claude");
    const target = join(base, "0.1.1"), failure = errno("EPERM");
    let retained = "";
    const rename = vi.fn((stage: string) => { retained = stage; throw failure; });
    const sleep = vi.fn(() => {
      mkdirSync(join(target, "dist"), { recursive: true });
      writeFileSync(join(target, "dist", "worker.mjs"), "backoff winner payload");
    });
    const error = captureFailure(() => selectRuntime(home, "claude", source, "0.1.1", { platform: "win32", rename, sleep }));
    expectDiagnostic(error, retained, target);
    expect(error.message).toContain("content conflict");
    expect(error.message).toContain("EPERM");
    expect(error.cause).toBe(failure);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(50);
    expect(payload(target)).toBe("backoff winner payload");
    expect(payload(retained)).toBe("new plugin payload");
    expect(readFileSync(selector, "utf8")).toBe(before);
  });

  it("wraps a reconciliation digest inspection failure and retains the original rename cause", () => {
    const { home, base, selector, before } = previous("codex");
    const target = join(base, "0.1.1"), failure = errno("EPERM");
    let retained = "";
    const rename = vi.fn((stage: string) => {
      retained = stage;
      // A file cannot be inspected as a plugin directory; digest's readdir fails.
      writeFileSync(target, "concurrent file retained");
      throw failure;
    });
    const sleep = vi.fn();
    const error = captureFailure(() => selectRuntime(home, "codex", source, "0.1.1", { platform: "win32", rename, sleep }));
    expectDiagnostic(error, retained, target);
    expect(error.message).toContain("scandir");
    expect(error.message).toContain("Original promotion error: Error: EPERM");
    expect(error.cause).toBe(failure);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(readFileSync(target, "utf8")).toBe("concurrent file retained");
    expect(payload(retained)).toBe("new plugin payload");
    expect(readFileSync(selector, "utf8")).toBe(before);
  });

  it("reports only publication preservation after the installer has completed a native Codex update", async () => {
    const { home, base, selector, before } = previous("codex");
    const nativeHome = join(root, "native-codex");
    const oldNative = liveUpdate.updateCodex(join(root, "old-source"), nativeHome, "0.1.0");
    vi.stubEnv("CODEX_HOME", nativeHome);
    vi.stubEnv("AGENT_BRIDGE_HOME", home);
    vi.spyOn(delegate, "resolveBinary").mockReturnValue("fixture-codex");
    vi.spyOn(sources, "pluginSourceDir").mockReturnValue(source);
    vi.spyOn(liveUpdate, "reportConnectedVersions").mockResolvedValue();
    const update = vi.spyOn(liveUpdate, "updateCodex");
    const failure = errno("EPERM"), sleep = vi.fn();
    let retained = "", publicationError: Error | undefined;
    const rename = vi.fn((stage: string) => { retained = stage; throw failure; });
    vi.spyOn(liveUpdate, "activatePluginRuntime").mockImplementation((dir, client, runtimeHome, version) => {
      try { return selectRuntime(runtimeHome, client, dir, version, { platform: "win32", rename, sleep }); }
      catch (error) { publicationError = error as Error; throw error; }
    });
    const lines: string[] = [];
    expect(await runInstaller({ action: "update", tools: ["codex"], yes: true, out: line => lines.push(line) })).toBe(1);
    expect(update).toHaveBeenCalledExactlyOnceWith(source);
    const nativeRoot = join(nativeHome, "plugins", "cache", "agent-bridge", "agent-bridge", APP_VERSION);
    const marketplace = JSON.parse(readFileSync(join(nativeHome, "agent-bridge-marketplace", ".agents", "plugins", "marketplace.json"), "utf8"));
    expect(marketplace.plugins[0].source.path).toBe(`./plugins/${APP_VERSION}`);
    expect(payload(nativeRoot)).toBe("new plugin payload");
    expect(payload(oldNative)).toBe("old plugin payload");
    expectDiagnostic(publicationError!, retained, join(base, APP_VERSION));
    expect(publicationError!.cause).toBe(failure);
    expect(lines.join("\n")).toContain(publicationError!.message);
    expect(rename).toHaveBeenCalledTimes(PLUGIN_PROMOTION_MAX_ATTEMPTS);
    expect(payload(retained)).toBe("new plugin payload");
    expect(readFileSync(selector, "utf8")).toBe(before);
    expect(existsSync(join(base, APP_VERSION))).toBe(false);
  });

  it.each(["EACCES", "EBUSY"])("also retries Windows %s", code => {
    const rename = vi.fn((stage: string, target: string) => {
      if (rename.mock.calls.length === 1) throw errno(code);
      renameSync(stage, target);
    });
    const sleep = vi.fn();
    publishPlugin(source, join(root, "versions", "codex"), "0.1.1", { platform: "win32", rename, sleep });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(PLUGIN_PROMOTION_RETRY_DELAY_MS);
  });

  it.each([
    ["linux", "EPERM"], ["darwin", "EPERM"], ["linux", "EACCES"], ["linux", "EBUSY"],
    ["win32", "EXDEV"], ["win32", "ENOENT"], ["win32", "EIO"], ["win32", undefined],
  ] as const)("does not retry %s / %s", (platform, code) => {
    const rename = vi.fn(() => { throw code ? errno(code) : new Error("uncategorized failure"); });
    const sleep = vi.fn(), base = join(root, "versions", "codex");
    expect(() => publishPlugin(source, base, "0.1.1", { platform, rename, sleep })).toThrow("stage is kept");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(stages(base)).toHaveLength(1);
    expect(existsSync(join(base, "0.1.1"))).toBe(false);
  });

  it("reuses an identical version without staging or renaming again", () => {
    const base = join(root, "versions", "codex");
    const target = publishPlugin(source, base, "0.1.1");
    const rename = vi.fn();
    expect(publishPlugin(source, base, "0.1.1", { rename })).toBe(target);
    expect(rename).not.toHaveBeenCalled();
    expect(stages(base)).toHaveLength(0);
  });
});

describe("missing packaged plugin guidance", () => {
  it("prints the exact package recovery command for a missing Antigravity build", async () => {
    vi.stubEnv("AGENT_BRIDGE_HOME", join(root, "bridge"));
    vi.spyOn(delegate, "resolveBinary").mockReturnValue("fixture-agy");
    vi.spyOn(antigravity, "antigravitySourceDir").mockReturnValue(null);
    const install = vi.spyOn(antigravity, "installAntigravity");
    const lines: string[] = [];
    expect(await runInstaller({ action: "install", tools: ["antigravity"], yes: true, out: line => lines.push(line) })).toBe(1);
    expect(lines.join("\n")).toContain("npx -y github:rennerdo30/agent-bridge install antigravity --yes");
    expect(install).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("prints the equivalent recovery command for missing %s source", async tool => {
    vi.stubEnv("AGENT_BRIDGE_HOME", join(root, "bridge"));
    vi.spyOn(delegate, "resolveBinary").mockReturnValue("fixture-cli");
    vi.spyOn(sources, "pluginSourceDir").mockReturnValue(null);
    vi.spyOn(liveUpdate, "reportConnectedVersions").mockResolvedValue();
    const update = vi.spyOn(liveUpdate, tool === "codex" ? "updateCodex" : "updateClaude");
    const activate = vi.spyOn(liveUpdate, "activatePluginRuntime");
    const lines: string[] = [];
    expect(await runInstaller({ action: "update", tools: [tool], yes: true, out: line => lines.push(line) })).toBe(1);
    expect(lines.join("\n")).toContain(`npx -y github:rennerdo30/agent-bridge install ${tool} --yes`);
    expect(update).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
