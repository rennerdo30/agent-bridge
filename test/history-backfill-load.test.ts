import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { backfillBytes, primeLargeHistoryBackfill, seedLargeHistoryBackfill } from "../scripts/history-backfill-fixture.js";
import { historyDbPath, historyReady } from "../src/core/history-store.js";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { writeFileSync } from "node:fs";
import { HistoryBackground } from "../src/core/history-background.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { makeEnv, until } from "./helpers.js";

it("keeps sends and ack below 1s p95 with zero lock failures during large CLI backfill", async () => {
  const env = makeEnv(), fixture = seedLargeHistoryBackfill(env.home);
  vi.stubEnv("CODEX_HOME",fixture.paths.codex); vi.stubEnv("CLAUDE_CONFIG_DIR",fixture.paths.claude);
  vi.stubEnv("XDG_DATA_HOME",join(env.home,"xdg-fixture")); vi.stubEnv("ANTIGRAVITY_CLI_HOME",fixture.paths.antigravity!);
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS","0");
  const errors: string[] = [], log = { ...nullLogger, warn: (text: string, meta?: unknown) => { errors.push(`${text}: ${JSON.stringify(meta)}`); }, error: (text: string, meta?: unknown) => { errors.push(`${text}: ${JSON.stringify(meta)}`); } };
  const store = new MessageStore(env.db,log), broker = new Broker(env.pipe,store,log,"fixture-token"), clients: BridgeClient[] = [];
  let history: DatabaseSync | undefined;
  try {
    await broker.listen();
    history = new DatabaseSync(historyDbPath(env.db),{timeout:3000});
    await until(() => historyReady(history!),20_000);
    primeLargeHistoryBackfill(history,env.home,fixture);
    // Schema readiness precedes discovery and the first durable transcript batch.
    // Start the traffic window once ingestion is observable, then require further
    // progress during that same window rather than counting startup as progress.
    await until(() => backfillBytes(history!,fixture)>0,5000);
    for (const name of ["sender","receiver"]) {
      const client = await BridgeClient.connect(env.pipe,log); clients.push(client);
      await client.request("hello",{protocol:PROTOCOL_VERSION,token:"fixture-token",peer:{id:name,name,agent:"codex",cwd:env.home,pid:process.pid,agentPid:null,sessionId:name,startedAt:Date.now(),autoWake:false}});
    }
    const before = backfillBytes(history,fixture), latencies: number[] = [], failed: string[] = [];
    const deadline = Date.now()+8000;
    while (Date.now()<deadline) {
      const start = performance.now();
      try {
        const result = await clients[0]!.request("send",{to:"receiver",body:"retained during large backfill"});
        await clients[1]!.request("ack",{ids:result.messages.map(m => m.id)});
      } catch (err) { failed.push(String(err)); }
      latencies.push(performance.now()-start);
      await new Promise(resolve => setTimeout(resolve,25));
    }
    latencies.sort((a,b)=>a-b);
    const p95 = latencies[Math.floor((latencies.length-1)*.95)]!;
    const after = backfillBytes(history,fixture);
    console.log(JSON.stringify({ inputBytes:fixture.bytes,before,after,sends:latencies.length,failures:failed.length,p95Ms:p95 }));
    expect(failed).toEqual([]); expect(errors).toEqual([]); expect(p95).toBeLessThan(1000);
    expect(after).toBeGreaterThan(before); expect(after).toBeLessThan(fixture.bytes);
    const bridge = new DatabaseSync(env.db,{readOnly:true});
    try { expect(bridge.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(0); expect(bridge.prepare("SELECT count(*) n FROM history_documents").get()!.n).toBe(0); } finally { bridge.close(); }
  } finally { for (const c of clients) c.close(); history?.close(); await broker.close(); await env.cleanup(); vi.unstubAllEnvs(); }
},30_000);

it("does not start a background worker when the environment kill switch disables ingestion", async () => {
  const env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST","false");
  const store = new MessageStore(env.db,nullLogger), broker = new Broker(env.pipe,store,nullLogger,"fixture-token");
  try { await broker.listen(); expect((broker as unknown as { historyBackground: unknown }).historyBackground).toBeNull(); }
  finally { await broker.close(); await env.cleanup(); vi.unstubAllEnvs(); }
});

it("monitors a config-disabled migration and resumes it when ingestion is enabled", async () => {
  const env = makeEnv(); writeFileSync(join(env.home,"config.json"),JSON.stringify({history:{ingest:false}}));
  const store = new MessageStore(env.db,nullLogger), broker = new Broker(env.pipe,store,nullLogger,"fixture-token");
  let history: DatabaseSync | undefined;
  try {
    await broker.listen();
    const worker = (broker as unknown as {historyBackground: HistoryBackground}).historyBackground;
    expect(worker).not.toBeNull();
    history = new DatabaseSync(historyDbPath(env.db),{timeout:100});
    await until(() => worker.status().paused,5000);
    expect(history.prepare("SELECT * FROM history_migration").get()).toBeUndefined();
    writeFileSync(join(env.home,"config.json"),JSON.stringify({history:{ingest:true}}));
    await until(() => historyReady(history!),10000);
    await until(() => worker.status().phase === "verified",5000);
    expect(worker.status()).toMatchObject({percent:100,paused:false,etaSeconds:0});
  } finally { history?.close(); await broker.close(); await env.cleanup(); }
});
