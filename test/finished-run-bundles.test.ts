import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { indexedFinishedRuns, packFinishedRuns } from "../src/core/finished-run-bundles.js";
import { readRetainedMetadataFile } from "../src/core/metadata-import.js";
vi.mock("node:fs",async original => ({...await original<typeof import("node:fs")>(),readFileSync:vi.fn((await original<typeof import("node:fs")>()).readFileSync),readdirSync:vi.fn((await original<typeof import("node:fs")>()).readdirSync)}));
let home: string;
afterEach(()=>{ if(home) closeMetadataDb(home); });
it("packs many finished runs into shared gzip members and leaves active and quoted-finish logs alone", () => {
 home = fs.mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"finished-bundles-"));
 const dir = join(home,"runs"); fs.mkdirSync(dir);
 const active = join(dir,"active.log"), quoted = join(dir,"quoted.log");
 fs.writeFileSync(active,"01:00:00 working\n"); fs.writeFileSync(quoted,"01:00:00 finished after 1s · quoted\n01:00:01 still running\n");
 for (let i=0;i<50;i++) {
  const log = join(dir,`finished-${i}.log`), raw = Buffer.from(`01:00:00 retained ${i} bytes\n01:00:01 finished after 1s · done\n`);
  fs.writeFileSync(log,raw); fs.writeFileSync(log.replace(/\.log$/,".json"),JSON.stringify({job:`job-${i}`,future:{keep:true}}));
  expect(packFinishedRuns(home,[log,active,quoted])).toBe(1);
  expect(readRetainedMetadataFile(home,`runs/finished-${i}.log`)).toEqual(raw);
 }
 expect(fs.readdirSync(join(home,"cold","bundles"))).toHaveLength(1);
 expect(fs.readdirSync(dir)).toEqual(["active.log","quoted.log"]);
 const reads = vi.mocked(fs.readFileSync).mockClear(), scans = vi.mocked(fs.readdirSync).mockClear();
 for(let i=0;i<10;i++) expect(indexedFinishedRuns(home)).toHaveLength(50);
 expect(reads).not.toHaveBeenCalled(); expect(scans).not.toHaveBeenCalled();
 expect(indexedFinishedRuns(home)[0]!.meta).toMatchObject({future:{keep:true}});
});
