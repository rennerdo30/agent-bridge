import type { Logger } from "../core/logger.js";

/** Last-resort protection for a dedicated runner's active turn, never the broker. */
export function guardRunnerErrors(
  log: Pick<Logger, "error">,
  events: Pick<NodeJS.Process, "on" | "off"> = process,
  stderr: Pick<NodeJS.WriteStream, "on" | "off" | "write"> = process.stderr,
): () => void {
  let reporting = false;
  let fallbackAttempted = false;
  const report = (event: string, error: unknown) => {
    if (reporting) return;
    reporting = true;
    // Reporting an unexpected callback failure must not itself throw from the guard.
    try {
      log.error("unexpected runner callback failure; active turn kept running", { event, error });
    } catch {
      if (!fallbackAttempted) {
        // Disable before writing: a broken stream may emit EPIPE after reporting resets.
        fallbackAttempted = true;
        try { stderr.write(`[job-runner] ${event}; active turn kept running (error logging failed)\n`); }
        catch { /* The delegate and its ownership scope must remain active even if stderr is unavailable. */ }
      }
    } finally { reporting = false; }
  };
  const rejection = (error: unknown) => report("unhandledRejection", error);
  const exception = (error: Error, origin: string) => report(origin, error);
  // A normal logger write can fail asynchronously. Absorb stream errors locally;
  // sending them through the global guard would write back to the same broken stream.
  const stderrError = () => { fallbackAttempted = true; };
  stderr.on("error", stderrError);
  events.on("unhandledRejection", rejection);
  events.on("uncaughtException", exception);
  return () => {
    events.off("unhandledRejection", rejection);
    events.off("uncaughtException", exception);
    stderr.off("error", stderrError);
  };
}
