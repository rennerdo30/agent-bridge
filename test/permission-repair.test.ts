import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as delegate from "../src/core/delegate.js";
import { PERMISSION_REPAIR_SCRIPT, permissionRepairPlan, repairPermissions } from "../src/core/permission-repair.js";
import { nullLogger } from "../src/core/logger.js";
import { runPermissionRepair } from "../src/cli/permission-repair.js";

let home: string;
beforeEach(() => { mkdirSync(".agent-bridge-test", { recursive: true }); home = mkdtempSync(join(process.cwd(), ".agent-bridge-test", "acl-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
describe("permission-only repair", () => {
  it("skips links and refuses linked roots or intermediate components without touching targets", async () => {
    const tree = join(home, "tree"), outside = join(home, "outside");
    mkdirSync(tree); mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "owner data");
    symlinkSync(outside, join(tree, "Library"), "junction");
    const plan = permissionRepairPlan(tree);
    expect(plan.paths).toEqual([tree]);
    expect(plan.skipped).toEqual([join(tree, "Library")]);
    expect(() => permissionRepairPlan(join(tree, "Library"))).toThrow("through a link");
    expect(() => permissionRepairPlan(join(tree, "Library", "keep.txt"))).toThrow("through a link");
    const output: string[] = [];
    expect(await runPermissionRepair([tree], home, nullLogger, (line) => output.push(line))).toBe(0);
    expect(output.join()).toContain("Nothing is deleted");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("owner data");
  });
  it.runIf(process.platform === "win32")("backs up original descriptors and restores inheritance without removing a byte", async () => {
    expect(PERMISSION_REPAIR_SCRIPT).not.toMatch(/SetOwner|takeown|\/setowner/i);
    const tree = join(home, "tree"); mkdirSync(tree);
    const file = join(tree, "unique.txt"); writeFileSync(file, "unique owner bytes");
    const ownerScript = "$item = Get-Item -LiteralPath ([Console]::In.ReadToEnd()); $item.GetAccessControl().Owner";
    const owner = () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ownerScript, "utf16le").toString("base64")], { encoding: "utf8", input: file }).trim();
    const originalOwner = owner();
    execFileSync("icacls.exe", [file, "/inheritance:d", "/Q"]);
    const result = await repairPermissions({ path: tree, home, apply: true, log: nullLogger });
    expect(result.result?.entries.filter((entry) => !entry.ok), JSON.stringify(result.result)).toEqual([]);
    expect(result.backup && existsSync(result.backup)).toBe(true);
    expect(JSON.parse(readFileSync(result.backup!, "utf8")).entries).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe("unique owner bytes");
    expect(owner()).toBe(originalOwner);
    const script = `$item = Get-Item -LiteralPath ([Console]::In.ReadToEnd()); $item.GetAccessControl().AreAccessRulesProtected`;
    const acl = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", input: file });
    expect(acl.trim()).toBe("False");
  });
  it("defaults to inspection and rejects unknown options", async () => {
    const result = await repairPermissions({ path: home, home, apply: false, log: nullLogger });
    expect(result.backup).toBeNull();
    await expect(runPermissionRepair([home, "--delete"], home, nullLogger, () => {})).rejects.toThrow("Usage");
  });
  it.runIf(process.platform === "win32")("retains reported ACL refusals, their original owner, bytes and backups", async () => {
    const tree = join(home, "refused"); mkdirSync(tree);
    const file = join(tree, "unique.txt"); writeFileSync(file, "retained refusal bytes");
    const invoke = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")], { encoding: "utf8", input: file }).trim();
    const descriptor = () => invoke("$item=Get-Item -LiteralPath ([Console]::In.ReadToEnd()); $item.GetAccessControl().Sddl");
    const original = descriptor();
    const run = delegate.runProcess;
    const native = vi.spyOn(delegate, "runProcess").mockImplementation(async opts => {
      if (!JSON.parse(String(opts.stdin)).apply) return run(opts);
      return { code: 0, stdout: JSON.stringify({ entries: [{ path: file, ok: false, error: "Access denied: fixture native refusal" }] }), stderr: "" } as Awaited<ReturnType<typeof run>>;
    });
    const result = await repairPermissions({ path: tree, home, apply: true, log: nullLogger });
    expect(result.result?.entries.find(entry => entry.path === file)).toMatchObject({ ok: false, error: expect.stringMatching(/unauthorized|denied/i) });
    expect(descriptor()).toBe(original);
    expect(readFileSync(file, "utf8")).toBe("retained refusal bytes");
    expect(existsSync(result.backup!)).toBe(true);
    expect(JSON.parse(readFileSync(result.backup!, "utf8")).entries.find((entry: { path: string }) => entry.path === file)).toMatchObject({ sddl: original, ok: true });
    expect(native).toHaveBeenCalledTimes(2);
  });
});
