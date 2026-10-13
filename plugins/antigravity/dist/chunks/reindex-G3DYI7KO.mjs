import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-UJHVCSMC.mjs";
import {
  BridgeClient
} from "./chunk-YAW243II.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-SXIGB3ZR.mjs";
import "./chunk-6HX4P36F.mjs";
import "./chunk-FB36ELJK.mjs";
import {
  migrateHistoryStore
} from "./chunk-T5CHXQ4M.mjs";
import "./chunk-AJ3G2ZXC.mjs";
import "./chunk-KQJ5KQYW.mjs";
import "./chunk-UUSRNKCB.mjs";
import "./chunk-CNEMWRSZ.mjs";
import "./chunk-PWDXY3Q6.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-DFGCM6KO.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-CY442UR7.mjs";
import {
  loadConfig
} from "./chunk-VFTNRBZD.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-Q5W6NH5D.mjs";
import "./chunk-MIHYBRIY.mjs";
import "./chunk-XW6H3A5N.mjs";
import "./chunk-DKK5INBH.mjs";
import {
  transcriptPaths
} from "./chunk-WM3QOXKL.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-2J3W5ZBZ.mjs";
import "./chunk-6JJ25VPZ.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-AH7X4KST.mjs";
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
