import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-BSQE6ZBW.mjs";
import {
  BridgeClient
} from "./chunk-CDNLVMZJ.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-3YLL4DTP.mjs";
import "./chunk-UDPHQAPO.mjs";
import "./chunk-TK3APK3O.mjs";
import "./chunk-MRHQ4FXL.mjs";
import "./chunk-HS6DDUE5.mjs";
import {
  migrateHistoryStore
} from "./chunk-NLJID2TW.mjs";
import "./chunk-GH2EGBH2.mjs";
import "./chunk-Z2YSUEGN.mjs";
import "./chunk-UGDUXM6A.mjs";
import {
  resolveDbPath
} from "./chunk-LWNZXNUI.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-VNQ4UNAO.mjs";
import "./chunk-R7RAGEUO.mjs";
import {
  loadConfig
} from "./chunk-XEYLJ2LK.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-HCKJFSF5.mjs";
import "./chunk-RVBPLF75.mjs";
import "./chunk-HFR36QD7.mjs";
import {
  transcriptPaths
} from "./chunk-NVDPULGI.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-RQIXW2IC.mjs";
import "./chunk-LG5QXURA.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-NT6Y2SKY.mjs";
import "./chunk-DEWCC5JJ.mjs";
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
