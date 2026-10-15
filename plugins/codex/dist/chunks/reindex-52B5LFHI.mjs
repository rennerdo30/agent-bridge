import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-UN7EZBGK.mjs";
import {
  BridgeClient
} from "./chunk-YZLDNKVX.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-MIY2F5E7.mjs";
import "./chunk-GHBZ5BFX.mjs";
import "./chunk-ZDJC76TV.mjs";
import {
  migrateHistoryStore
} from "./chunk-NLJID2TW.mjs";
import "./chunk-TK3APK3O.mjs";
import "./chunk-HS6DDUE5.mjs";
import "./chunk-NRK7AMHA.mjs";
import "./chunk-ZRV7NPJA.mjs";
import "./chunk-UGDUXM6A.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-2M4FBSCA.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-ZOA3PODP.mjs";
import {
  loadConfig
} from "./chunk-QPCOBHQB.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-RWIV74TX.mjs";
import "./chunk-NVTFJMO3.mjs";
import "./chunk-T4EU6Q4H.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-RQIXW2IC.mjs";
import "./chunk-LG5QXURA.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-NT6Y2SKY.mjs";
import "./chunk-VNQ4UNAO.mjs";
import {
  transcriptPaths
} from "./chunk-NVDPULGI.mjs";
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
