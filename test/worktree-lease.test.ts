import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { worktreeLease } from "../src/core/worktree-state.js";
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
const identity = vi.hoisted(() => ({ current: vi.fn(), alive: vi.fn() }));
vi.mock("../src/core/process-identity.js", () => ({ processIdentity: identity.current, isProcessIdentityAlive: identity.alive }));
let home: string, wt: { path: string }, key: string;
const current = "boot:current-start";
beforeEach(() => {
 home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"row-lease-"));
 wt = { path: join(home,"worktree") }; mkdirSync(wt.path);
 writeFileSync(join(wt.path,"owner-data"),"unique owner bytes");
 key = createHash("sha256").update(resolve(wt.path).toLowerCase()).digest("hex");
 identity.current.mockReset().mockReturnValue(current);
 identity.alive.mockReset().mockImplementation((pid,start) => pid === process.pid && start === current);
});
afterEach(() => {
 expect(readFileSync(join(wt.path,"owner-data"),"utf8")).toBe("unique owner bytes");
 closeMetadataDb(home); vi.useRealTimers();
});
const row = () => metadataDb(home).prepare("SELECT * FROM worktree_leases WHERE key=?").get(key)!;
const archives = () => metadataDb(home).prepare("SELECT * FROM worktree_lease_archive").all();
it("stores identity, job ID and nonce and archives releases without file leases", () => {
 const release = worktreeLease(home,wt,"job-fixture");
 expect(row()).toMatchObject({pid:process.pid,identity:current,job_id:"job-fixture",archived_at:null});
 expect(existsSync(join(home,"worktree-leases"))).toBe(false);
 expect(() => worktreeLease(home,wt)).toThrow(`Holder: pid ${process.pid}`);
 const original = row(); release(); release();
 expect(archives()).toHaveLength(1);
 expect(archives()[0]).toMatchObject({nonce:original.nonce,identity:current,archive_reason:"owner released"});
 const next = worktreeLease(home,wt); release();
 expect(row().archived_at).toBeNull(); next(); expect(archives()).toHaveLength(2);
});
it.each([12345,process.pid])("recovers provably gone identity for PID %i and retains its row", pid => {
 const old = worktreeLease(home,wt,"old-job");
 metadataDb(home).prepare("UPDATE worktree_leases SET pid=?,identity='previous-start' WHERE key=?").run(pid,key);
 const original = row(), next = worktreeLease(home,wt,"next-job");
 expect(identity.alive).toHaveBeenCalledWith(pid,"previous-start");
 expect(archives()[0]).toMatchObject({nonce:original.nonce,pid,identity:"previous-start",job_id:"old-job"});
 old(); expect(row().archived_at).toBeNull(); next();
});
it.each([true,undefined])("never reclaims live or unknown identity (%s) with an ancient heartbeat", alive => {
 const release = worktreeLease(home,wt);
 metadataDb(home).prepare("UPDATE worktree_leases SET heartbeat_at=0 WHERE key=?").run(key);
 identity.alive.mockReturnValue(alive);
 expect(() => worktreeLease(home,wt)).toThrow("Holder:");
 expect(archives()).toHaveLength(0); expect(row().heartbeat_at).toBe(0); release();
});
it("imports legacy empty directories as unknown protected holders and retains the original", () => {
 const path = join(home,"worktree-leases",key); mkdirSync(path,{recursive:true});
 expect(() => worktreeLease(home,wt)).toThrow("unknown legacy owner");
 expect(row()).toMatchObject({pid:null,identity:null,legacy_path:path});
 expect(readdirSync(path)).toEqual([]); expect(archives()).toHaveLength(0);
});
it("heartbeats update only matching active ownership", () => {
 vi.useFakeTimers(); const release = worktreeLease(home,wt), before = Number(row().heartbeat_at);
 vi.advanceTimersByTime(10_000); expect(Number(row().heartbeat_at)).toBeGreaterThan(before);
 release(); const archived = row().heartbeat_at; vi.advanceTimersByTime(20_000);
 expect(row().heartbeat_at).toBe(archived);
});
it("refuses acquisition when its own creation identity is unknown", () => {
 identity.current.mockReturnValue(undefined);
 expect(() => worktreeLease(home,wt)).toThrow("unreconciled lease");
});
it("refuses linked legacy storage without touching its target", () => {
 const target = join(home,"retained-target"); mkdirSync(target); writeFileSync(join(target,"keep"),"retained");
 symlinkSync(target,join(home,"worktree-leases"),"junction");
 expect(() => worktreeLease(home,wt)).toThrow("Linked storage path retained");
 expect(readdirSync(target)).toEqual(["keep"]);
});
