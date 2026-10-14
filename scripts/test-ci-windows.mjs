import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.argv.slice(2).some(arg => /^-freshvolume(?::|$)/i.test(arg))) {
  console.error("FreshVolume unavailable: administrator/VHD support requires a separately reviewed owned-handle mechanism. No volume or fixture mutation was attempted.");
  process.exitCode = 1;
} else if (process.platform !== "win32") {
  console.error("test:ci-windows requires Windows. Use npm test / npm run test:integration on this OS.");
  process.exitCode = 1;
} else {
  const env = { ...process.env };
  // PowerShell 7's module paths can break Windows PowerShell 5.1 autoloading.
  // Let the child reconstruct its own default module search path.
  delete env.PSModulePath;
  // No shell interpolation, elevated relaunch, fixed drive or account name.
  const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./test-ci-windows.ps1", import.meta.url)),
    "-NodePath", process.execPath, ...process.argv.slice(2),
  ], { stdio: "inherit", windowsHide: true, env });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
}
