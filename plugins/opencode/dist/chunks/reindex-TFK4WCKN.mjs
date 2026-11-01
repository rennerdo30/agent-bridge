import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-RRXDL2FI.mjs";
import "./chunk-QETSCJMA.mjs";
import {
  BridgeClient
} from "./chunk-DNFDFVNI.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-EBFZLA6V.mjs";
import "./chunk-3K4MQ6LK.mjs";
import "./chunk-G43ZUHHU.mjs";
import {
  ConversationIngestor
} from "./chunk-L7QDQHDE.mjs";
import "./chunk-EFJUYY5Q.mjs";
import {
  migrateHistoryStore
} from "./chunk-LBNMQXNB.mjs";
import "./chunk-A6OZQOEL.mjs";
import "./chunk-OVUI7CCQ.mjs";
import "./chunk-TW7ZCQ2L.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-3L5NAV5P.mjs";
import "./chunk-6B2AZPTL.mjs";
import "./chunk-KT6UGBZN.mjs";
import "./chunk-HSYLC53O.mjs";
import {
  loadConfig
} from "./chunk-3ONQFYIQ.mjs";
import "./chunk-JKWPEEII.mjs";
import "./chunk-VUZ3I7UH.mjs";
import "./chunk-5NPKKVPB.mjs";
import {
  transcriptPaths
} from "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-6QSR4FTZ.mjs";
import "./chunk-YEN6TM2D.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-FJ2TGOLZ.mjs";
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
