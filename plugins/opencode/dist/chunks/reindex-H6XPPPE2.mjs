import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-FHX5BWGH.mjs";
import {
  BridgeClient
} from "./chunk-2BRMUATN.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-C3TF5GQL.mjs";
import "./chunk-R7CL4XSI.mjs";
import "./chunk-FHUAEA6M.mjs";
import "./chunk-EMTLQ2GW.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-A5VNQSZQ.mjs";
import {
  loadOrCreateToken
} from "./chunk-PCXGTT2Z.mjs";
import {
  loadConfig
} from "./chunk-S5K6II4C.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-WFART47T.mjs";
import {
  ConversationIngestor
} from "./chunk-HEIYXMFF.mjs";
import {
  migrateHistoryStore
} from "./chunk-VQ4YRK77.mjs";
import "./chunk-WM5CXQL2.mjs";
import "./chunk-P3D6CPFS.mjs";
import "./chunk-TQCKZODX.mjs";
import {
  transcriptPaths
} from "./chunk-OVBYB4CB.mjs";
import "./chunk-I7XFUMWM.mjs";
import "./chunk-RVGYULDQ.mjs";
import "./chunk-UT6DV2NX.mjs";
import "./chunk-GN275QYC.mjs";
import "./chunk-CJPLA2VJ.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-PEBTAWO6.mjs";

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
