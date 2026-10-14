import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JOBS_STATE_DEFAULT, productionJobsCommand, ShadowJobsLedger, counter, parseExactJson, type ShadowResult } from "../src/core/state-jobs.js";
import { seedShadowFixture, fixtureRequest, fixtureTransport, shadowWriterProgram } from "./fixtures/state-jobs-writer.js";

// Authored locally; execution belongs to the automatic hosted all-OS matrix.
let path: string, db: DatabaseSync, ledger: ShadowJobsLedger;
beforeEach(() => {
  path = join(mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "state-jobs-")), "shadow.db");
  db = new DatabaseSync(path); seedShadowFixture(db); ledger = new ShadowJobsLedger(db);
});
afterEach(() => { db.close(); }); // Keep every fixture artifact; no cleanup.
const apply = (overrides: Record<string, unknown> = {}, transport = fixtureTransport()) =>
  ledger.applyShadowCommand(fixtureRequest(overrides), transport);
const transport = (overrides: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...JSON.parse(fixtureTransport().toString()), ...overrides }));
const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

it("is default-off and production commands cannot be enabled by DTOs/flags/identity claims", () => {
  expect(JOBS_STATE_DEFAULT).toBe("off");
  for (const input of [null, {}, { enabled: true, shadow: false, broker: true, receiver: true }, JSON.parse(fixtureRequest().toString())])
    expect(productionJobsCommand(input)).toEqual({ status: "authority_unavailable" });
  expect(count("shadow_jobs")).toBe(0);
});
it("commits exact row/turn/event/receipt/evidence identity and bytes in one transaction", () => {
  const raw = fixtureRequest({ unknown: { context: "\r\n\u0000", report: "full report", steering: ["next", "next"] } });
  const reply = ledger.applyShadowCommand(raw, fixtureTransport());
  expect(reply).toMatchObject({ status: "shadow_committed", commitVersion: "1", version: "1", turnGeneration: "1", sideEffects: "none" });
  const command = db.prepare("SELECT * FROM shadow_commands").get()!, event = db.prepare("SELECT * FROM shadow_events").get()!;
  expect(Buffer.from(command.request as Uint8Array)).toEqual(raw);
  expect(Buffer.from(command.transport as Uint8Array)).toEqual(fixtureTransport());
  expect(Buffer.from(event.request as Uint8Array)).toEqual(raw);
  expect(event).toMatchObject({ issuer: "fixture-session", installation: "fixture-install", lineage: "fixture-lineage", epoch: "1", command_id: "create-job", generation: "1", previous_version: "0", version: "1" });
  expect(JSON.parse(String(command.receipt))).toEqual(reply);
  expect(db.prepare("SELECT * FROM shadow_jobs").get()).toMatchObject({ execution_evidence: "unknown" });
  expect(count("shadow_turns")).toBe(1); expect(count("shadow_evidence")).toBe(1);
});
it("replays the exact command without a second transition or event and retains conflicting command bytes", () => {
  const first = apply(), snapshot = ledger.snapshot();
  expect(apply()).toEqual(first); expect(ledger.snapshot()).toBe(snapshot);
  const changed = fixtureRequest({ acceptedContext: "changed immutable request" });
  expect(ledger.applyShadowCommand(changed, fixtureTransport())).toEqual({ status: "refused", reason: "command_id_conflict" });
  expect(Buffer.from(db.prepare("SELECT request FROM shadow_command_conflicts").get()!.request as Uint8Array)).toEqual(changed);
  expect(count("shadow_commands")).toBe(1); expect(count("shadow_events")).toBe(1);
});
it("returns the original durable receipt after reopen and simulated epoch/registration change", () => {
  const accepted = apply(); db.close(); db = new DatabaseSync(path); ledger = new ShadowJobsLedger(db);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
  db.exec("UPDATE shadow_scope SET epoch='2',instance='successor'; UPDATE shadow_sessions SET registration='2',version='2'");
  expect(apply({}, transport({ epoch: "2", instance: "successor", registration: "2" }))).toEqual(accepted);
  expect(apply({ commandId: "new-command" }, transport({ epoch: "2", instance: "successor", registration: "2" })))
    .toEqual({ status: "refused", reason: "stale_authority_generation" });
  expect(count("shadow_events")).toBe(1);
});
it("does not expose a receipt under a reused name/different session or revoked binding", () => {
  apply(); db.prepare("INSERT INTO shadow_sessions VALUES (?,?,?,?)").run("different-stable-session", "1", "1", "connected");
  expect(apply({}, transport({ sessionId: "different-stable-session" }))).toEqual({ status: "refused", reason: "stale_session_generation" });
  db.exec("UPDATE shadow_sessions SET state='ended' WHERE id='fixture-session'");
  expect(apply()).toEqual({ status: "refused", reason: "unknown_shadow_session" });
  expect(count("shadow_commands")).toBe(1);
});
it.each([
  ["turnGeneration", "2", "stale_turn_generation"], ["expectedVersion", "0", "stale_row_version"],
  ["sessionGeneration", "2", "stale_session_generation"], ["authorityGeneration", "2", "stale_authority_generation"],
  ["jobId", "unknown", "unknown_job_identity"], ["lineage", "different", "stale_authority_generation"],
])("refuses stale or unknown %s before mutation", (field, value, reason) => {
  apply(); const snapshot = ledger.snapshot();
  expect(apply({ commandId: "stale", operation: "transition", expectedVersion: "1", lifecycle: "queued", [field]: value }))
    .toEqual({ status: "refused", reason });
  expect(ledger.snapshot()).toBe(snapshot); expect(count("shadow_events")).toBe(1);
});
it("never rewrites terminal history and allocates a monotonic continuation generation", () => {
  apply();
  expect(apply({ commandId: "early-continue", operation: "continue", expectedVersion: "1" })).toEqual({ status: "refused", reason: "unsettled_turn" });
  expect(apply({ commandId: "terminal", operation: "transition", expectedVersion: "1", lifecycle: "terminal" })).toMatchObject({ version: "2" });
  expect(apply({ commandId: "continue", operation: "continue", expectedVersion: "2" })).toMatchObject({ version: "3", turnGeneration: "2" });
  const history = db.prepare("SELECT * FROM shadow_turns WHERE generation='1'").get();
  expect(history).toMatchObject({ lifecycle: "terminal", version: "2" });
  expect(apply({ commandId: "late-result", operation: "transition", expectedVersion: "3", lifecycle: "terminal" }))
    .toEqual({ status: "refused", reason: "stale_turn_generation" });
  expect(db.prepare("SELECT * FROM shadow_turns WHERE generation='1'").get()).toEqual(history);
});
it("retains evidence-only bytes without faking a row transition", () => {
  apply(); const result = apply({ commandId: "report", operation: "evidence", expectedVersion: "1", acceptedReport: "\r\nfull", context: ["a", "a"] });
  expect(result).toMatchObject({ commitVersion: "2", version: "1" });
  expect(count("shadow_evidence")).toBe(2); expect(db.prepare("SELECT version FROM shadow_jobs").get()!.version).toBe("1");
});
it("rolls back row, turn, event, receipt and cursor when the receipt write fails", () => {
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON shadow_commands BEGIN SELECT RAISE(ABORT,'synthetic receipt fault'); END");
  expect(apply()).toEqual({ status: "refused", reason: "synthetic receipt fault" });
  for (const table of ["shadow_jobs", "shadow_turns", "shadow_events", "shadow_commands", "shadow_evidence"]) expect(count(table)).toBe(0);
  expect(db.prepare("SELECT commit_version FROM shadow_scope").get()!.commit_version).toBe("0");
});
it("refuses unknown/malformed state, transitions, ambiguous JSON and imprecise counters", () => {
  for (const raw of [Buffer.from([255]), Buffer.from('{"id":'), Buffer.from('{"x":1,"x":2}'),
    fixtureRequest({ expectedVersion: 0 }), fixtureRequest({ authorityGeneration: "01" }),
    fixtureRequest({ expectedVersion: "9223372036854775808" }), fixtureRequest({ operation: "launch" }),
    fixtureRequest({ operation: "transition", lifecycle: "__proto__" })])
    expect(ledger.applyShadowCommand(raw, fixtureTransport()).status).toBe("refused");
  apply(); db.exec("UPDATE shadow_jobs SET version='unknown'");
  expect(apply({ commandId: "bad-row", operation: "evidence", expectedVersion: "1" })).toEqual({ status: "refused", reason: "malformed_counter" });
  expect(() => parseExactJson(Buffer.from('{"nested":{"a":1,"\\u0061":2}}'))).toThrow("ambiguous_json");
  expect(counter("9223372036854775807")).toBe("9223372036854775807");
});
it("keeps stable snapshots byte-identical and refuses exhausted counters atomically", () => {
  apply(); expect(ledger.snapshot()).toBe(ledger.snapshot());
  db.exec("UPDATE shadow_scope SET commit_version='9223372036854775807'");
  const snapshot = ledger.snapshot();
  expect(apply({ commandId: "overflow", operation: "evidence", expectedVersion: "1" })).toEqual({ status: "refused", reason: "counter_exhausted" });
  expect(ledger.snapshot()).toBe(snapshot); expect(count("shadow_commands")).toBe(1);
});
it("refuses weaker durability or malformed retained receipts rather than claiming acceptance", () => {
  db.exec("PRAGMA synchronous=NORMAL");
  expect(apply()).toEqual({ status: "refused", reason: "shadow_durability_unavailable" });
  db.exec("PRAGMA synchronous=FULL"); apply();
  db.prepare("UPDATE shadow_commands SET receipt=?").run('{"status":"shadow_committed","digest":"forged"}');
  expect(apply()).toEqual({ status: "refused", reason: "malformed_receipt" });
  expect(count("shadow_events")).toBe(1);
});

async function race(requests: Buffer[]): Promise<ShadowResult[]> {
  const source = readFileSync(new URL("../src/core/state-jobs.ts", import.meta.url), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(transformSync(source, { loader: "ts", format: "esm", target: "es2023" }).code).toString("base64");
  const gate = new SharedArrayBuffer(4), ready: Promise<void>[] = [], results: Promise<ShadowResult>[] = [], exits: Promise<void>[] = [];
  for (const request of requests) {
    const worker = new Worker(shadowWriterProgram, { eval: true, workerData: { path, gate, moduleUrl, request, transport: fixtureTransport() } });
    let markReady!: () => void, failReady!: (e: Error) => void;
    ready.push(new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; }));
    results.push(new Promise<ShadowResult>((resolve, reject) => {
      worker.on("message", message => {
        if (message.ready) markReady();
        else if (message.error) { const error = new Error(message.error); failReady(error); reject(error); }
        else resolve(message.result);
      });
      worker.on("error", error => { failReady(error); reject(error); });
    }));
    exits.push(new Promise<void>((resolve, reject) => { worker.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))); worker.on("error", reject); }));
  }
  await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const replies = await Promise.all(results); await Promise.all(exits); return replies;
}
it("serializes real concurrent SQLite writers: one CAS winner and one stale version refusal", async () => {
  apply();
  const replies = await race(["writer-a", "writer-b"].map(commandId => fixtureRequest({ commandId, operation: "transition", expectedVersion: "1", lifecycle: "queued" })));
  expect(replies.filter(r => r.status === "shadow_committed")).toHaveLength(1);
  expect(replies.filter(r => r.status === "refused")).toEqual([{ status: "refused", reason: "stale_row_version" }]);
  expect(count("shadow_commands")).toBe(2); expect(count("shadow_events")).toBe(2);
});
it("deduplicates identical concurrently replayed command IDs with one durable event", async () => {
  const replies = await race([fixtureRequest(), fixtureRequest()]);
  expect(replies[0]).toMatchObject({ status: "shadow_committed" }); expect(replies[0]).toEqual(replies[1]);
  expect(count("shadow_events")).toBe(1); expect(count("shadow_commands")).toBe(1);
});
