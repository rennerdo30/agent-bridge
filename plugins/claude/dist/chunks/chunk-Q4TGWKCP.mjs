import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/mcp/job-runner-errors.ts
function guardRunnerErrors(log, events = process, stderr = process.stderr, label = { message: "unexpected runner callback failure; active turn kept running", fallback: "[job-runner] {event}; active turn kept running (error logging failed)" }) {
  let reporting = false;
  let fallbackAttempted = false;
  const report = (event, error) => {
    if (reporting) return;
    reporting = true;
    try {
      log.error(label.message, { event, error });
    } catch {
      if (!fallbackAttempted) {
        fallbackAttempted = true;
        try {
          stderr.write(`${label.fallback.replace("{event}", event)}
`);
        } catch {
        }
      }
    } finally {
      reporting = false;
    }
  };
  const rejection = (error) => report("unhandledRejection", error);
  const exception = (error, origin) => report(origin, error);
  const stderrError = () => {
    fallbackAttempted = true;
  };
  stderr.on("error", stderrError);
  events.on("unhandledRejection", rejection);
  events.on("uncaughtException", exception);
  return () => {
    events.off("unhandledRejection", rejection);
    events.off("uncaughtException", exception);
    stderr.off("error", stderrError);
  };
}
function guardServerErrors(log, events = process) {
  return guardRunnerErrors(log, events, process.stderr, { message: "unexpected background failure; MCP server kept running", fallback: "[agent-bridge] {event}; MCP server kept running (error logging failed)" });
}

export {
  guardRunnerErrors,
  guardServerErrors
};
