import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-V4IBQCGW.mjs";
import {
  BridgeClient
} from "./chunk-ASAE72VD.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import "./chunk-J6HXVXTK.mjs";
import {
  ConversationIngestor
} from "./chunk-OHBE7NMM.mjs";
import {
  migrateHistoryStore
} from "./chunk-6P65RSGE.mjs";
import "./chunk-27TG33K6.mjs";
import "./chunk-ABTE2HH2.mjs";
import "./chunk-YES4373V.mjs";
import "./chunk-6X5RM53J.mjs";
import "./chunk-GU7RYQWR.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-XXRMZ4WL.mjs";
import "./chunk-SGLKLGWY.mjs";
import {
  loadConfig
} from "./chunk-TGMXHXCW.mjs";
import "./chunk-SQ6EFEOQ.mjs";
import "./chunk-EA6YAI7Y.mjs";
import "./chunk-4QXHCXBU.mjs";
import {
  transcriptPaths
} from "./chunk-CUBGS4RC.mjs";
import "./chunk-TEK6WK2V.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-GEXILR6G.mjs";
import "./chunk-2JCQIMR7.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-EZXQJRQM.mjs";
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
