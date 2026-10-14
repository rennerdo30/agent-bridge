import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/cli/open.ts
import { spawn } from "node:child_process";
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", '""', url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}

export {
  openBrowser
};
