import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-YVR7OVYQ.mjs";
import {
  BridgeClient
} from "./chunk-L4OZ22KA.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  historyBudget
} from "./chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunk-UVGMNSE5.mjs";
import "./chunk-C6OKFSQM.mjs";
import "./chunk-VYYLWKCH.mjs";
import {
  migrateHistoryStore
} from "./chunk-R7HXRKWE.mjs";
import "./chunk-3CXCL26P.mjs";
import "./chunk-PTKEHKCJ.mjs";
import "./chunk-2SS2FJK7.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-D4YQRCDF.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-NAIKP65T.mjs";
import "./chunk-CZNWCZNZ.mjs";
import {
  loadConfig
} from "./chunk-5I7IJLKF.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-DAI2VPPJ.mjs";
import "./chunk-CCQJERHQ.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-OK4AKY67.mjs";
import "./chunk-JCI74XRN.mjs";
import {
  transcriptPaths
} from "./chunk-TFQZM67X.mjs";
import "./chunk-S4W4VZWF.mjs";
import "./chunk-5KYAJ3AQ.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-XTHHW5FU.mjs";
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
