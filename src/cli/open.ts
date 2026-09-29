import { spawn } from "node:child_process";

/** Open a URL in the default browser. Best effort: the URL is printed anyway. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/d", "/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: the user can open the printed URL
  }
}
