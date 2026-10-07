import { BridgeClient } from "../core/client.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { resolveDbPath } from "../core/paths.js";
import type { RequestMap } from "../core/protocol.js";
import { MessageStore } from "../core/store.js";
import { loadOrCreateToken } from "../core/token.js";
import { ConversationIngestor } from "../core/conversations.js";
import { transcriptPaths } from "../core/transcripts/common.js";
import { DatabaseSync } from "node:sqlite";
import { migrateHistoryStore } from "../core/history-store.js";
import { loadConfig } from "../core/config.js";

type Batch = RequestMap["reindexHistory"][1];

/** Maintenance authenticates without hello: it must not join a mailbox or create decision mail. */
export async function runReindex(home: string, pipe: string, log: Logger, out: (text: string) => void): Promise<number> {
  let client: BridgeClient | null = null;
  let store: MessageStore | null = null;
  let ingest: ConversationIngestor | null = null;
  let source: DatabaseSync | null = null;
  try {
    if (!loadConfig(home,"other",log).history.ingest) { out("History ingestion disabled by history.ingest or AGENT_BRIDGE_HISTORY_INGEST."); return 0; }
    try { client = await BridgeClient.connect(pipe, log); }
    catch (err) {
      if (!["ENOENT", "ECONNREFUSED"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
    let batch: (reset: boolean) => Promise<Batch>;
    if (client) {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
      const connected = client;
      batch = (reset) => connected.request("reindexHistory", { reset });
    } else {
      // Same migration/backup executor as broker startup, without chat-peer or purge side effects.
      store = new MessageStore(resolveDbPath(home), log);
      await migrateHistoryStore(store.file, store.history.storageDatabase);
      const index = store.history;
      source = new DatabaseSync(store.file,{readOnly:true,timeout:100});
      ingest=new ConversationIngestor(index.database,home,transcriptPaths(),source);
      batch = async (reset) => {
        if(reset)index.reset();const result=index.tick();const work=result.work+ingest!.tick();
        return {work,discovering:result.discovering || ingest!.discovering};
      };
    }
    let result = await batch(true), ticks = 1;
    while (result.work || result.discovering) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = await batch(false);
      ticks++;
    }
    out(`History index rebuilt in ${ticks} bounded batches.`);
    return 0;
  } finally { client?.close(); ingest?.close(); source?.close(); store?.close(); }
}
