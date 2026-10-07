import { BridgeClient } from "../core/client.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { resolveDbPath } from "../core/paths.js";
import type { RequestMap } from "../core/protocol.js";
import { MessageStore } from "../core/store.js";
import { loadOrCreateToken } from "../core/token.js";
import { ConversationIngestor } from "../core/conversations.js";
import { transcriptPaths } from "../core/transcripts/common.js";

type Batch = RequestMap["reindexHistory"][1];

/** Maintenance authenticates without hello: it must not join a mailbox or create decision mail. */
export async function runReindex(home: string, pipe: string, log: Logger, out: (text: string) => void): Promise<number> {
  let client: BridgeClient | null = null;
  let store: MessageStore | null = null;
  let ingest: ConversationIngestor | null = null;
  try {
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
      const index = store.history;
      ingest=new ConversationIngestor(index.database,home,transcriptPaths());
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
  } finally { client?.close(); ingest?.close(); store?.close(); }
}
