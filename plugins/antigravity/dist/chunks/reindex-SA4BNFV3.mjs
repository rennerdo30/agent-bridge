import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  BridgeClient
} from "./chunk-3PRPU65R.mjs";
import {
  ConversationIngestor
} from "./chunk-K5UGVRMW.mjs";
import {
  resolveDbPath
} from "./chunk-YZVUMNJR.mjs";
import {
  loadOrCreateToken
} from "./chunk-PCXGTT2Z.mjs";
import "./chunk-G6MLDC24.mjs";
import {
  MessageStore
} from "./chunk-4WPDYHCU.mjs";
import "./chunk-LBG7DP2E.mjs";
import "./chunk-L2G75S3E.mjs";
import "./chunk-S7VTNSOR.mjs";
import "./chunk-QBVZNCPA.mjs";
import "./chunk-SOPZATYP.mjs";
import {
  transcriptPaths
} from "./chunk-AT5K4DQH.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-WXTV3GSE.mjs";
import "./chunk-2EE2AGA4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-4BCYRJ3A.mjs";
import "./chunk-BOOG2SC5.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-X27LYYGH.mjs";
import "./chunk-HHAVWD7J.mjs";

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
