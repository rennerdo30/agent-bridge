import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-E2QJ2ZPR.mjs";
import {
  BridgeClient
} from "./chunk-IXIWOPMO.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-O7BBY4FG.mjs";
import "./chunk-LZSRZUXD.mjs";
import "./chunk-QTHBWHU6.mjs";
import {
  migrateHistoryStore
} from "./chunk-OAJOKZAB.mjs";
import "./chunk-A6D7ZYP5.mjs";
import "./chunk-HZ4MFXRS.mjs";
import "./chunk-4PRKEOTA.mjs";
import "./chunk-HAJENJ6M.mjs";
import "./chunk-HC5UTNDN.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  loadOrCreateToken,
  resolveDbPath
} from "./chunk-QE5Y5JCD.mjs";
import "./chunk-2UCPNPKV.mjs";
import {
  loadConfig
} from "./chunk-BEZD7FHM.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-GT6BLZHK.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-VXKZ7TFV.mjs";
import "./chunk-4S5VWBNU.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-SCPRRSA3.mjs";
import "./chunk-GGCBZOQR.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-G5PLFO4A.mjs";
import "./chunk-VWILPC5Y.mjs";
import {
  transcriptPaths
} from "./chunk-NVDPULGI.mjs";
import "./chunk-FG32ZSGV.mjs";
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
