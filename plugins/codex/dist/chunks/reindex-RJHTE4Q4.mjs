import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-YVYLVX2T.mjs";
import "./chunk-QETSCJMA.mjs";
import {
  BridgeClient
} from "./chunk-ZUMBSQL2.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-EBFZLA6V.mjs";
import "./chunk-JKOQRVH4.mjs";
import "./chunk-OPS7FDS3.mjs";
import {
  ConversationIngestor
} from "./chunk-F7NKHNFQ.mjs";
import "./chunk-OCY2H76D.mjs";
import {
  migrateHistoryStore
} from "./chunk-WC4TZO5O.mjs";
import "./chunk-RQVKF3OB.mjs";
import "./chunk-232B5QQC.mjs";
import "./chunk-3AJE5HKA.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-B7XY2YXQ.mjs";
import "./chunk-6B2AZPTL.mjs";
import "./chunk-TQU3MUQ5.mjs";
import "./chunk-YUGQP7EN.mjs";
import {
  loadConfig
} from "./chunk-25ZINL7I.mjs";
import "./chunk-HW66ALAN.mjs";
import "./chunk-AQPKN3LV.mjs";
import "./chunk-ET5446BJ.mjs";
import {
  transcriptPaths
} from "./chunk-I32N5HZ3.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-KXBAGLCR.mjs";
import "./chunk-JIPLCRE3.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-URJEL5KY.mjs";
import "./chunk-EMDJN7RB.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/reindex.ts
import { DatabaseSync } from "node:sqlite";
async function runReindex(home, pipe, log, out) {
  let client = null;
  let store = null;
  let ingest = null;
  let source = null;
  try {
    if (!loadConfig(home, "other", log).history.ingest) {
      out("History ingestion disabled by history.ingest or AGENT_BRIDGE_HISTORY_INGEST.");
      return 0;
    }
    try {
      client = await BridgeClient.connect(pipe, log);
    } catch (err) {
      if (!["ENOENT", "ECONNREFUSED"].includes(err.code ?? "")) throw err;
    }
    let batch;
    if (client) {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
      const connected = client;
      batch = (reset) => connected.request("reindexHistory", { reset });
    } else {
      store = new MessageStore(resolveDbPath(home), log);
      await migrateHistoryStore(store.file, store.history.storageDatabase, void 0, void 0, void 0, true);
      const index = store.history;
      source = new DatabaseSync(store.file, { readOnly: true, timeout: 100 });
      ingest = new ConversationIngestor(index.database, home, transcriptPaths(), source);
      batch = async (reset) => {
        const budget = await historyBudget(home, loadConfig(home, "other", log).history.budgetBytes);
        if (budget.paused) throw new Error("History storage budget reached; import paused with cursors and sources retained. Raise history.budgetBytes to resume.");
        if (reset) index.reset();
        const result2 = index.tick();
        const work = result2.work + ingest.tick();
        return { work, discovering: result2.discovering || ingest.discovering };
      };
    }
    let result = await batch(true), ticks = 1;
    while (result.work || result.discovering) {
      await new Promise((resolve) => setImmediate(resolve));
      result = await batch(false);
      ticks++;
    }
    out(`History index rebuilt in ${ticks} bounded batches.`);
    return 0;
  } finally {
    client?.close();
    ingest?.close();
    source?.close();
    store?.close();
  }
}
export {
  runReindex
};
