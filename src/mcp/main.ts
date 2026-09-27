import { startServer } from "./server.js";

startServer().catch((err) => {
  process.stderr.write(`agent-bridge MCP server failed to start: ${String((err as Error)?.stack ?? err)}\n`);
  process.exit(1);
});
