import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-WKKYKRZG.mjs";
import {
  BridgeClient
} from "./chunk-VPDV2STZ.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import "./chunk-74CJX7AQ.mjs";
import "./chunk-OJRWE2B7.mjs";
import {
  ConversationIngestor
} from "./chunk-WTJ5VDMO.mjs";
import "./chunk-JAKRNANM.mjs";
import {
  migrateHistoryStore
} from "./chunk-O2I4NUA7.mjs";
import "./chunk-XM2AEVYN.mjs";
import "./chunk-WPBFJ2DC.mjs";
import "./chunk-DD73OAMD.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-HJVM6Y2U.mjs";
import "./chunk-7UIHPV7O.mjs";
import {
  loadConfig
} from "./chunk-TQSBSS34.mjs";
import "./chunk-ZL7ZZFVV.mjs";
import "./chunk-IYW5KAMA.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-LCZB6GNB.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-G2HU363Z.mjs";
import "./chunk-SKBC6OTJ.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-O26G5HFG.mjs";
import "./chunk-EMB34XJI.mjs";
import {
  transcriptPaths
} from "./chunk-OX5J3NNH.mjs";
import "./chunk-W6KF56AK.mjs";
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
