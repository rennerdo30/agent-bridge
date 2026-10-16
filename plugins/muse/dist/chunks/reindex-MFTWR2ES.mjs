import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-EC6OAYNW.mjs";
import "./chunk-QETSCJMA.mjs";
import {
  BridgeClient
} from "./chunk-S5SL64EZ.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-EBFZLA6V.mjs";
import "./chunk-RTCTNVJF.mjs";
import "./chunk-LY4G6OZD.mjs";
import {
  ConversationIngestor
} from "./chunk-7LOJ4GHV.mjs";
import "./chunk-JLUOIFVD.mjs";
import {
  migrateHistoryStore
} from "./chunk-T3GGV4TC.mjs";
import "./chunk-67SPTL5M.mjs";
import "./chunk-KQXI22O6.mjs";
import "./chunk-UVHBYFOD.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-5YUMH7RA.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-KBNZV2V7.mjs";
import {
  loadConfig
} from "./chunk-V3SUTKKO.mjs";
import "./chunk-PJLFHRLV.mjs";
import "./chunk-IKJMNO54.mjs";
import "./chunk-22ZCB4PT.mjs";
import {
  transcriptPaths
} from "./chunk-I32N5HZ3.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-LGFTSWER.mjs";
import "./chunk-WV46DNR7.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-GTACKGIN.mjs";
import "./chunk-ARGAVNKJ.mjs";
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
