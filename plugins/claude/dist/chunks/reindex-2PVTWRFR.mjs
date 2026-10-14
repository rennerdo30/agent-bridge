import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-BHV6ZL7N.mjs";
import {
  BridgeClient
} from "./chunk-UQ75CONU.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-PNMKRUDP.mjs";
import "./chunk-NMSXIG52.mjs";
import "./chunk-UATL3Q4C.mjs";
import {
  migrateHistoryStore
} from "./chunk-5VYWEPQE.mjs";
import "./chunk-A6D7ZYP5.mjs";
import "./chunk-HZ4MFXRS.mjs";
import "./chunk-4PRKEOTA.mjs";
import "./chunk-HAJENJ6M.mjs";
import "./chunk-SAHHTEHT.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-MC6YEO5C.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-NE6GQ2GI.mjs";
import {
  loadConfig
} from "./chunk-PC26HO4O.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-7NH7XSAT.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-6WACHX2M.mjs";
import "./chunk-CWCDN2JJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-5US2OQUB.mjs";
import "./chunk-NU7S2DHP.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-G5PLFO4A.mjs";
import "./chunk-LU5OH4AB.mjs";
import {
  transcriptPaths
} from "./chunk-NVDPULGI.mjs";
import "./chunk-4O6KB7UQ.mjs";
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
