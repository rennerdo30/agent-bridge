import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCommand, unwrapNpmShim } from "../src/core/delegate.js";
import { runMusePluginCommand } from "../src/cli/muse-install.js";
import { nullLogger } from "../src/core/logger.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("Muse Windows launcher resolution", () => {
  it.runIf(process.platform === "win32")("uses executable argv for spaced paths through the shared installer resolver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse spaced launcher ")); dirs.push(dir);
    const bin = join(dir, "muse.cmd"), script = join(dir, ".muse-launcher.ps1"), output = join(dir, "argv.json");
    writeFileSync(bin, '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\n');
    writeFileSync(script, '[IO.File]::WriteAllText($env:AB_FIXTURE_ARGV, (ConvertTo-Json -InputObject @($args) -Compress))');
    vi.stubEnv("AB_FIXTURE_ARGV", output);
    const args = ["plugins", "install", join(dir, "workspace with spaces")];
    const target = resolveCommand(bin, args, process.env, nullLogger);
    expect(target.needsShell).toBe(false);
    expect(target.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]);
    expect(await runMusePluginCommand(bin, args)).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
    writeFileSync(bin, "@echo off\r\nsome-unknown-program %*\r\n");
    expect(() => resolveCommand(bin, ["x & echo injected"], process.env, nullLogger)).toThrow("unsafe argument");
    expect(() => runMusePluginCommand(bin, ["plugins"])).toThrow("Unsupported Muse CMD launcher");
  });
  it("refuses unrecognized PowerShell options and unresolved environment references", () => {
    const shim = '"%AB_MISSING_ROOT%\\powershell.exe" -NoProfile -Command evil -File "%~dp0.muse-launcher.ps1" %*';
    expect(unwrapNpmShim("C:\\fixture\\muse.cmd", () => shim)).toBeNull();
  });
});
