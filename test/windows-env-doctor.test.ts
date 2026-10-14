import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsUserPathFindings } from "../src/cli/windows-env-doctor.js";

it("reports only persistent Windows PATH counts through a bounded read-only probe", async () => {
  const probe = vi.fn(async () => ({ stdout: JSON.stringify({ length: 2300, dotnetToolsEntries: 4 }) }));
  const findings = await windowsUserPathFindings("win32", probe);
  expect(findings.map(f => f.code)).toEqual(["windows-user-path-long", "windows-user-path-dotnet-tools"]);
  expect(findings.every(f => !f.fixable)).toBe(true);
  const [command, args, options] = probe.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
  expect(command).toBe("powershell.exe");
  expect(args.at(-1)).toContain("GetEnvironmentVariable('Path', 'User')");
  expect(args.at(-1)).not.toMatch(/SetEnvironmentVariable|Set-Item|Write-Output\s+\$pathValue/);
  expect(options).toMatchObject({ timeout: 2000, maxBuffer: 4096, windowsHide: true });
  expect(JSON.stringify(findings)).not.toContain("PATH=");
});

it("does not warn at the thresholds or probe other platforms", async () => {
  const probe = vi.fn(async () => ({ stdout: '{"length":2000,"dotnetToolsEntries":2}' }));
  expect(await windowsUserPathFindings("linux", probe)).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
  expect(await windowsUserPathFindings("win32", probe)).toEqual([]);
});

it("suppresses invalid metrics and failed probes without exposing output", async () => {
  for (const stdout of ['invalid', '{"length":-1,"dotnetToolsEntries":4}', '{"length":2300}'])
    expect(await windowsUserPathFindings("win32", async () => ({ stdout }))).toEqual([]);
  expect(await windowsUserPathFindings("win32", async () => { throw new Error("synthetic PATH contents must remain private"); })).toEqual([]);
});

it.runIf(process.platform === 'win32')("runs the exact generated PowerShell parser against synthetic single-backslash paths", async () => {
  const exec = promisify(execFile);
  const findings = await windowsUserPathFindings('win32', async (command, args, options) => {
    const source = args.at(-1)!;
    const script = source.replace("[Environment]::GetEnvironmentVariable('Path', 'User')",
      "'D:\\fixture\\.dotnet\\tools;D:/fixture/.dotnet/tools/;D:\\fixture\\.DOTNET\\TOOLS\\;D:\\fixture\\xdotnet\\tools'");
    expect(script).not.toContain('GetEnvironmentVariable');
    return exec(command, [...args.slice(0, -1), script], options);
  });
  expect(findings).toEqual([expect.objectContaining({ code: 'windows-user-path-dotnet-tools', detail: expect.stringContaining('3 .dotnet/tools entries') })]);
});
