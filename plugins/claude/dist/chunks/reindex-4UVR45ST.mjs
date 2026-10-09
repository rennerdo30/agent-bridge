import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-3U5M4XII.mjs";
import {
  BridgeClient
} from "./chunk-VMLMAYUW.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-C3TF5GQL.mjs";
import "./chunk-DV7W25S5.mjs";
import "./chunk-F7FSK2FI.mjs";
import "./chunk-TVWYB3UI.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-L4M5HEV4.mjs";
import {
  loadOrCreateToken
} from "./chunk-PCXGTT2Z.mjs";
import {
  loadConfig
} from "./chunk-WRYAOPNG.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-XPITHFGJ.mjs";
import {
  ConversationIngestor
} from "./chunk-S344MR6M.mjs";
import {
  migrateHistoryStore
} from "./chunk-OLZR6XVO.mjs";
import "./chunk-3CXCL26P.mjs";
import "./chunk-BW76OTAT.mjs";
import "./chunk-TO3M23RT.mjs";
import {
  transcriptPaths
} from "./chunk-CUZHUOFY.mjs";
import "./chunk-JNVJDIQM.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-CM6KYE44.mjs";
import "./chunk-SH6MQ2WI.mjs";
import "./chunk-SFW3GO73.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

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
