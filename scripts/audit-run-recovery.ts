import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listRuns } from "../src/cli/ui.js";
import { readHistoryJobs, readRunLogs } from "../src/core/run-history.js";
import { readTranscript, transcriptPaths } from "../src/core/transcripts/index.js";
import type { AgentKind } from "../src/core/protocol.js";

/** Inspection only: never starts a dashboard, repairs a store, or launches a CLI. */
const home = resolve(process.argv[2] ?? join(homedir(), ".agent-bridge"));
const paths = transcriptPaths();
const recovered = listRuns(home).filter((run) => run.recovered);
const agents: Record<string, { recovered: number; withTranscript: number }> = {};
for (const run of recovered) {
  const count = agents[run.agent] ??= { recovered: 0, withTranscript: 0 };
  count.recovered++;
  if (readTranscript({ agent: run.agent as AgentKind, sessionId: run.sessionId ?? null, cwd: run.workdir ?? "" }, "0", undefined, paths)) count.withTranscript++;
}
process.stdout.write(`${JSON.stringify({ home, archivedRuns: readRunLogs(home).filter((run) => run.archived).length, storedJobs: readHistoryJobs(home).size, recoveredJobs: recovered.length, recoveredWithTranscript: Object.values(agents).reduce((sum, count) => sum + count.withTranscript, 0), agents }, null, 2)}\n`);
