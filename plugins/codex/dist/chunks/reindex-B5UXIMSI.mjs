import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MessageStore
} from "./chunk-OSPAFVQU.mjs";
import "./chunk-ZVUNLWSK.mjs";
import {
  BridgeClient
} from "./chunk-QKVEMNKK.mjs";
import {
  ConversationIngestor
} from "./chunk-QZHT7RY5.mjs";
import "./chunk-URQRJGSR.mjs";
import "./chunk-HJBA32EE.mjs";
import {
  resolveDbPath
} from "./chunk-AAHUVIX2.mjs";
import "./chunk-56DKLGNR.mjs";
import {
  loadOrCreateToken
} from "./chunk-PCXGTT2Z.mjs";
import "./chunk-SOPZATYP.mjs";
import {
  transcriptPaths
} from "./chunk-424BA3TS.mjs";
import "./chunk-JJMNBQDB.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-JYWG6ADH.mjs";
import "./chunk-CLF3ZYME.mjs";
import "./chunk-HPETZCQA.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-DQEWVRBU.mjs";

// src/cli/reindex.ts
async function runReindex(home, pipe, log, out) {
  let client = null;
  let store = null;
  let ingest = null;
  try {
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
      const index = store.history;
      ingest = new ConversationIngestor(index.database, home, transcriptPaths());
      batch = async (reset) => {
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
    store?.close();
  }
}
export {
  runReindex
};
