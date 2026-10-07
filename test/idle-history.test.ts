import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, store: MessageStore, db: DatabaseSync, index: HistoryIndex;
beforeEach(() => {
  env=makeEnv(); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS","0"); store=new MessageStore(env.db,nullLogger); db=new DatabaseSync(env.db);
  index=new HistoryIndex(db,env.home,{claude:join(env.home,"native"),codex:join(env.home,"native"),opencode:join(env.home,"native")});
});
afterEach(async () => { index.close();db.close();store.close();vi.restoreAllMocks();vi.unstubAllEnvs();await env.cleanup(); });
const drain = () => { for(let n=0;n<200;n++) { const result=index.tick(true);if(!result.work&&!result.discovering)return; } throw new Error("background sweep did not converge"); };
it("drains finite sweeps, prioritizes watched appends and discovers unwatched files on fallback", () => {
  let now=100_000;vi.spyOn(Date,"now").mockImplementation(()=>now);
  const runs=join(env.home,"runs");mkdirSync(runs,{recursive:true});
  for(let i=0;i<40;i++)writeFileSync(join(runs,`2026-10-07-00-00-00-codex-${i}.log`),"00:00:00 retained original\n");
  drain();
  for(let i=0;i<5;i++)expect(index.tick(true)).toEqual({work:0,discovering:false});
  const changed=join(runs,"2026-10-07-00-00-00-codex-39.log");appendFileSync(changed,"00:00:01 watched_append_needle\n");index.notify(changed);drain();
  expect(index.search({query:"watched_append_needle"}).hits).toHaveLength(1);
  writeFileSync(join(runs,"2026-10-07-00-00-00-codex-late.log"),"00:00:00 fallback_discovery_needle\n");now+=30_001;drain();
  expect(index.search({query:"fallback_discovery_needle"}).hits).toHaveLength(1);
});
