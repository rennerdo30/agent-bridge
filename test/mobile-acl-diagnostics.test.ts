import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileActivationFault, WINDOWS_PRIVATE_ACL_TIMEOUT_MS, windowsPrivateAcl, type PrivateAclDiagnostic } from "../src/mobile/config.js";
import { loadMobileIdentity, readPrivateMaterial } from "./mobile-acl-fixture.js";
import { MobileActivation } from "../src/mobile/activation.js";
import { nullLogger } from "../src/core/logger.js";
import { protect } from "../src/network/pairing.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: vi.fn() }));
const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const run = vi.mocked(execFile);
function home(): string { const root = resolve(".agent-bridge-test/mobile-acl-diagnostics"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "acl-")); }
const origins = ["https://192.168.1.235:8443"];
const secret = "private-key-credential-S-1-5-21-123456-identity";

// Hold the real adapter at child completion; exact logical time forces its deadline category.
function completion(error: object | null, output: string, elapsed = 37) {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const end = vi.fn();
  run.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: object | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => { now += elapsed; callback(error, output, secret); });
    return { stdin: { end } };
  }) as unknown as typeof execFile);
  return end;
}
afterEach(() => { vi.restoreAllMocks(); run.mockReset(); });

describe("safe bounded Windows ACL outcomes", () => {
  it.each([
    ["allowed", null, "allow", 37, true],
    ["lookup_failure", { code: 1, message: secret }, "lookup_failure", 37, false],
    ["permission_refused", { code: 1, message: secret }, "permission_refused", 37, false],
    ["process_failure", { code: "ENOENT", message: secret }, secret, 37, false],
    ["process_failure", { code: 1, message: secret }, "allow", 37, false],
    ["process_failure", null, secret, 37, false],
    ["process_failure", { killed: true, code: null, signal: "SIGTERM" }, secret, WINDOWS_PRIVATE_ACL_TIMEOUT_MS - 1, false],
    ["process_failure", { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGTERM" }, secret, WINDOWS_PRIVATE_ACL_TIMEOUT_MS, false],
    ["process_failure", { killed: true, code: null, signal: "SIGKILL" }, secret, WINDOWS_PRIVATE_ACL_TIMEOUT_MS, false],
    ["timeout", { killed: true, code: null, signal: "SIGTERM", message: secret }, secret, WINDOWS_PRIVATE_ACL_TIMEOUT_MS, false],
  ] as const)("reports %s without native output or identity", async (aclOutcome, error, output, elapsed, allowed) => {
    const end = completion(error, output, elapsed), sink = vi.fn(), file = join(home(), secret);
    expect(await windowsPrivateAcl(file, sink)).toBe(allowed);
    expect(sink.mock.calls).toEqual([[{ aclOutcome, aclElapsedMs: elapsed }]]);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret); expect(JSON.stringify(sink.mock.calls)).not.toContain(file);
    expect(end).toHaveBeenCalledExactlyOnceWith(file + "\n");
    expect(run.mock.calls[0]![2]).toMatchObject({ timeout: WINDOWS_PRIVATE_ACL_TIMEOUT_MS, maxBuffer: 8192, windowsHide: true });
    const options = run.mock.calls[0]![2] as { env: Record<string, string> };
    expect(Object.keys(options.env).some(name => name.toLowerCase() === "psmodulepath")).toBe(false);
    const script = Buffer.from((run.mock.calls[0]![1] as string[]).at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("if($owner -ne $caller)"); expect(script).toContain("@($caller,'S-1-5-18','S-1-5-32-544')");
  });
  it("contains process startup and diagnostic sink failures, and refuses newline paths before launch", async () => {
    run.mockImplementation(() => { throw new Error(secret); });
    const sink = vi.fn((_outcome: PrivateAclDiagnostic) => { throw new Error(secret); });
    expect(await windowsPrivateAcl(join(home(), secret), sink)).toBe(false);
    expect(sink.mock.calls[0]![0]).toMatchObject({ aclOutcome: "process_failure" });
    run.mockClear(); sink.mockClear();
    expect(await windowsPrivateAcl("secret\nidentity", sink)).toBe(false);
    expect(run).not.toHaveBeenCalled(); expect(sink.mock.calls[0]![0]).toMatchObject({ aclOutcome: "permission_refused" });
  });
  it.each(["timeout", "process_failure", "lookup_failure", "permission_refused"] as const)("retains %s through pinned activation without touching existing material", async aclOutcome => {
    // Seed independent protected material without an unrelated native lookup; all
    // original identity tests and the native policy probes still use real ACLs.
    const dir = home(), first = await loadMobileIdentity(dir, origins, { platform: "win32", acl: async () => true }), identityDir = join(dir, "mobile-identity");
    const snapshot = () => Object.fromEntries(["keys", "states", "archive"].map(child => [child, Object.fromEntries(readdirSync(join(identityDir, child)).map(name => [name, readFileSync(join(identityDir, child, name)).toString("base64")]))]));
    const before = snapshot();
    const elapsed = aclOutcome === "timeout" ? WINDOWS_PRIVATE_ACL_TIMEOUT_MS : 37;
    completion(aclOutcome === "timeout" ? { killed: true, code: null, signal: "SIGTERM", message: secret } : { code: aclOutcome === "process_failure" ? "ENOENT" : 1, message: secret }, aclOutcome, elapsed);
    await expect(loadMobileIdentity(dir, origins, { platform: "win32", rotation: "stage" })).rejects.toMatchObject({ message: "material_unavailable", aclDiagnostic: { aclOutcome, aclElapsedMs: elapsed } });
    expect(snapshot()).toEqual(before);
    const keyFile = join(identityDir, "keys", readdirSync(join(identityDir, "keys"))[0]!);
    await expect(readPrivateMaterial(keyFile, { platform: "win32" })).rejects.toMatchObject({ message: "material_unavailable", aclDiagnostic: { aclOutcome, aclElapsedMs: elapsed } });
    expect(readFileSync(keyFile)).toEqual(first.key);
    const warn = vi.fn();
    const activation = new MobileActivation({ isBroker: true } as ConstructorParameters<typeof MobileActivation>[0],
      { enabled: true, pcId: secret, origins, listeners: [{ origin: origins[0]!, bindAddress: "192.168.1.235", port: 8443, tls: "pinned" }] },
      { home: dir, pipe: secret, port: 8444, log: { ...nullLogger, warn } },
      { identity: async (...args) => loadMobileIdentity(args[0], args[1], { platform: "win32" }) });
    expect(await activation.start()).toBeUndefined(); expect(activation.status()).toBe("material_unavailable");
    expect(warn.mock.calls).toHaveLength(1);
    const fields = warn.mock.calls[0]![1];
    expect(fields).toEqual({ requestId: expect.any(String), errorCategory: "material_unavailable", aclOutcome, aclElapsedMs: elapsed });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret); expect(JSON.stringify(warn.mock.calls)).not.toContain(dir); expect(JSON.stringify(warn.mock.calls)).not.toContain(first.key.toString());
    expect(snapshot()).toEqual(before);
  });
  it("copies only fixed diagnostic fields and refuses hostile categories", () => {
    const extra = { aclOutcome: "lookup_failure" as const, aclElapsedMs: 37.9, file: secret, stderr: secret, owner: secret };
    expect(new MobileActivationFault("material_unavailable", extra).aclDiagnostic).toEqual({ aclOutcome: "lookup_failure", aclElapsedMs: 37 });
    expect(new MobileActivationFault("material_unavailable", { aclOutcome: secret, aclElapsedMs: 1 } as unknown as PrivateAclDiagnostic).aclDiagnostic).toBeUndefined();
    expect(new MobileActivationFault("material_unavailable", { aclOutcome: "timeout", aclElapsedMs: NaN }).aclDiagnostic).toBeUndefined();
  });
  it("executes descriptor lookup and permission refusal protocol (native on Windows) with safe timing", async () => {
    if (process.platform !== "win32") {
      // Exercise protocol/policy on other hosts; real native PowerShell runs on Windows.
      for (const [output, allowed] of [["allow", true], ["lookup_failure", false], ["permission_refused", false]] as const) {
        completion(allowed ? null : { code: 1 }, output); const sink = vi.fn();
        expect(await windowsPrivateAcl(join(home(), secret), sink)).toBe(allowed);
        expect(sink.mock.calls).toEqual([[{ aclOutcome: allowed ? "allowed" : output, aclElapsedMs: 37 }]]);
        const script = Buffer.from((run.mock.calls.at(-1)![1] as string[]).at(-1)!, "base64").toString("utf16le");
        expect(script).toContain("if($owner -ne $caller)"); expect(script).toContain("@($caller,'S-1-5-18','S-1-5-32-544')");
      }
      return;
    }
    run.mockImplementation(native.execFile);
    const dir = home(), file = join(dir, "private"), sink = vi.fn((value: PrivateAclDiagnostic) => { if (value.aclOutcome !== "allowed") console.error("mobile ACL check failed", value); }); writeFileSync(file, secret); protect(file, 0o600, true);
    expect(await windowsPrivateAcl(file, sink)).toBe(true);
    expect(await windowsPrivateAcl(join(dir, "missing"), sink)).toBe(false);
    execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)", "/Q"], { windowsHide: true, stdio: "pipe" });
    expect(await windowsPrivateAcl(file, sink)).toBe(false);
    expect(sink.mock.calls.map(([value]) => value.aclOutcome)).toEqual(["allowed", "lookup_failure", "permission_refused"]);
    for (const [value] of sink.mock.calls) expect(value).toEqual({ aclOutcome: expect.any(String), aclElapsedMs: expect.any(Number) });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret); expect(JSON.stringify(sink.mock.calls)).not.toContain(dir);
    expect(readFileSync(file).toString()).toBe(secret);
  });
});
