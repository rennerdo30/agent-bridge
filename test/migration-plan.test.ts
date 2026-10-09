import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { migrationPlan } from "../src/core/migration-plan.js";
import { runDoctor } from "../src/cli/doctor.js";

it("plans ordered migration from file metadata without creating stores or reading credentials", async () => {
 const home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"migration-plan-"));
 for(const dir of ["jobs","runs","backups/.pending-fixture",".migration-snapshots"]) mkdirSync(join(home,dir),{recursive:true});
 writeFileSync(join(home,"bridge.db"),Buffer.alloc(120));
 writeFileSync(join(home,"jobs","fixture.json"),Buffer.alloc(30));
 writeFileSync(join(home,"backups",".pending-fixture","retained.db"),Buffer.alloc(45));
 writeFileSync(join(home,"credentials.private"),"fixture only");
 const before = readdirSync(home), modified = statSync(join(home,"bridge.db")).mtimeMs;
 const plan = migrationPlan(home);
 expect(plan.steps.map(step=>step.order)).toEqual([1,2,3,4,5]);
 expect(plan.steps[0]!.bytes).toBe(120); expect(plan.steps[2]!.files).toBe(1);
 expect(plan.ownerDecisions.find(item=>item.path==="backups")).toMatchObject({files:1,bytes:45,newerCopyVerified:false});
 const output: string[] = [];
 expect(await runDoctor(["--migration-plan","--json"],home,text=>output.push(text),vi.fn())).toBe(0);
 expect(JSON.parse(output[0]!).readOnly).toBe(true);
 expect(readdirSync(home)).toEqual(before); expect(statSync(join(home,"bridge.db")).mtimeMs).toBe(modified);
 expect(output[0]).not.toContain("credentials.private");
});
it("rejects action flags and does not traverse a linked inventory directory", async () => {
 const home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"migration-plan-links-"));
 const target = join(home,"retained"); mkdirSync(target); writeFileSync(join(target,"keep"),"retained");
 symlinkSync(target,join(home,"jobs"),"junction");
 expect(migrationPlan(home).inventory.find(item=>item.path==="jobs")).toMatchObject({linked:1,files:0});
 expect(await runDoctor(["--migration-plan","--fix","--yes"],home,()=>{},vi.fn())).toBe(2);
 expect(readdirSync(target)).toEqual(["keep"]);
});
