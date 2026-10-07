import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { permissionRepairPlan, repairPermissions } from "../src/core/permission-repair.js";
import { nullLogger } from "../src/core/logger.js";
import { runPermissionRepair } from "../src/cli/permission-repair.js";

let home: string;
beforeEach(() => { mkdirSync(".agent-bridge-test", { recursive: true }); home = mkdtempSync(join(process.cwd(), ".agent-bridge-test", "acl-")); });
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
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
    const tree = join(home, "tree"); mkdirSync(tree);
    const file = join(tree, "unique.txt"); writeFileSync(file, "unique owner bytes");
    execFileSync("icacls.exe", [file, "/inheritance:d", "/Q"]);
    const result = await repairPermissions({ path: tree, home, apply: true, log: nullLogger });
    expect(result.result?.entries.filter((entry) => !entry.ok)).toEqual([]);
    expect(result.backup && existsSync(result.backup)).toBe(true);
    expect(JSON.parse(readFileSync(result.backup!, "utf8")).entries).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe("unique owner bytes");
    const script = `$item = Get-Item -LiteralPath ([Console]::In.ReadToEnd()); $item.GetAccessControl().AreAccessRulesProtected`;
    const acl = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", input: file });
    expect(acl.trim()).toBe("False");
  });
  it("defaults to inspection and rejects unknown options", async () => {
    const result = await repairPermissions({ path: home, home, apply: false, log: nullLogger });
    expect(result.backup).toBeNull();
    await expect(runPermissionRepair([home, "--delete"], home, nullLogger, () => {})).rejects.toThrow("Usage");
  });
});
