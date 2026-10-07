import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  BridgeClient
} from "./chunk-OJOD5JQS.mjs";
import {
  resolveDbPath
} from "./chunk-I5ATHBYL.mjs";
import {
  loadOrCreateToken
} from "./chunk-PCXGTT2Z.mjs";
import {
  ConversationIngestor
} from "./chunk-HQFTDE63.mjs";
import "./chunk-55UBJKRO.mjs";
import "./chunk-QN2BR77F.mjs";
import {
  MessageStore
} from "./chunk-MSF7TNIK.mjs";
import "./chunk-IVSM3443.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-SOPZATYP.mjs";
import "./chunk-CV444Y3C.mjs";
import "./chunk-BMYN33JS.mjs";
import "./chunk-UPRSZQYD.mjs";
import "./chunk-JIZVJD5Z.mjs";
import "./chunk-JSAVG5BJ.mjs";
import {
  transcriptPaths
} from "./chunk-H2JCI6FF.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-FVHLG3WF.mjs";
import "./chunk-VNX2WF5E.mjs";
import "./chunk-TPCM6ZR4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-SKREW3F6.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-6PRX5EOQ.mjs";
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
