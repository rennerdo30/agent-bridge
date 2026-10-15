import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-4DJPNIFK.mjs";
import {
  BridgeClient
} from "./chunk-SFABJ7R4.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import "./chunk-DZ224LAW.mjs";
import "./chunk-66VUFIBS.mjs";
import {
  ConversationIngestor
} from "./chunk-UOSZCOMB.mjs";
import "./chunk-4MGDH6P4.mjs";
import {
  migrateHistoryStore
} from "./chunk-32VTIIWS.mjs";
import "./chunk-V4VFK2LZ.mjs";
import "./chunk-PZ6QYUCT.mjs";
import "./chunk-3XI26TCG.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-KW3CITQI.mjs";
import "./chunk-4H5DTXKU.mjs";
import {
  loadConfig
} from "./chunk-2NHSQ4EH.mjs";
import "./chunk-3X2VUWP6.mjs";
import "./chunk-RE3I7AXX.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-RZEJWGWA.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-BQPZDGG6.mjs";
import "./chunk-OIZ5WNNF.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-HIVVJXLN.mjs";
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
