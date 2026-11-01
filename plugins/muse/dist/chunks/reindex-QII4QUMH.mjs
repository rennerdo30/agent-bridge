import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-IX7WN3AZ.mjs";
import "./chunk-QETSCJMA.mjs";
import {
  BridgeClient
} from "./chunk-KTYOQPYH.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-EBFZLA6V.mjs";
import "./chunk-7ZWWSWE4.mjs";
import "./chunk-CL4UYPLR.mjs";
import {
  ConversationIngestor
} from "./chunk-QGAIFS2J.mjs";
import "./chunk-6GGQBW5R.mjs";
import {
  migrateHistoryStore
} from "./chunk-OTG4WNVZ.mjs";
import "./chunk-EWUETLH4.mjs";
import "./chunk-GNEDOXJP.mjs";
import "./chunk-7X6TW5XE.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-R3XLUILN.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-63ALE7MW.mjs";
import "./chunk-KCELIZDL.mjs";
import {
  loadConfig
} from "./chunk-EGBXL467.mjs";
import "./chunk-WU2EUSC5.mjs";
import "./chunk-7TGCOQY2.mjs";
import "./chunk-SIMWQAYI.mjs";
import {
  transcriptPaths
} from "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-RBBYN7QN.mjs";
import "./chunk-BA6BFOKV.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-K3U5YPG2.mjs";
import "./chunk-AAH2UEC3.mjs";
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
