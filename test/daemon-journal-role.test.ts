import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { lifecycleActorSchema, sameLifecycleInstance, LIFECYCLE_STATES, LIFECYCLE_NEXT } from "../src/core/daemon-lifecycle-role.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, writer: DatabaseSync, path: string;
let instance: { nonce: string; pid: number; creationIdentity: string };
beforeEach(async () => {
  env = makeEnv(); path = join(env.home, "owned-actor-schema.sqlite");
  const creationIdentity = await readProcessIdentity(process.pid); expect(creationIdentity).toBeTruthy();
  instance = { nonce: randomUUID(), pid: process.pid, creationIdentity: creationIdentity! };
  writer = new DatabaseSync(path); writer.exec("CREATE TABLE actor_format_fixture (id INTEGER PRIMARY KEY, json TEXT NOT NULL)");
});
afterEach(async () => { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); await env.cleanup(); });
function insert(value: unknown) { writer.prepare("INSERT INTO actor_format_fixture(json) VALUES (?)").run(JSON.stringify(value)); }
function committed() {
  const reader = new DatabaseSync(path, { readOnly: true });
  try { reader.exec("PRAGMA query_only=ON"); return reader.prepare("SELECT json FROM actor_format_fixture ORDER BY id").all().map(row => JSON.parse(String(row.json))); }
  finally { reader.close(); }
}

describe("canonical actor DATA format in owned real SQLite (no census/permit or Windows receipt acceptance)", () => {
  it("keeps exact creation-bound actor in independently committed rows, excluding an uncommitted replacement", () => {
    const actor = { kind: "old", instance }; insert(actor);
    writer.exec("BEGIN IMMEDIATE"); insert({ kind: "successor", instance: { ...instance, nonce: randomUUID() } });
    expect(committed()).toEqual([actor]);
    expect(lifecycleActorSchema.parse(committed()[0])).toEqual(actor);
    writer.exec("COMMIT"); expect(committed()).toHaveLength(2);
    // Data parsing is deliberately NOT permission to acquire a writable owner.
    expect(sameLifecycleInstance(lifecycleActorSchema.parse(committed()[1]).instance, instance)).toBe(false);
  });
  it("rejects copied role flags/unknown actors and distinguishes reused PID from exact creation identity", () => {
    insert({ kind: "old", instance: { ...instance, creationIdentity: "different-owned-fixture-creation" } });
    insert({ kind: "old", instance, complete: true }); insert({ kind: "serving", instance });
    const rows = committed();
    expect(sameLifecycleInstance(lifecycleActorSchema.parse(rows[0]).instance, instance)).toBe(false);
    expect(lifecycleActorSchema.safeParse(rows[1]).success).toBe(false);
    expect(lifecycleActorSchema.safeParse(rows[2]).success).toBe(false);
    expect(committed()).toEqual(rows); // No repair/removal of unrecognized retained data.
  });
  it("retains every canonical state and refuses historical enums without making transition data mutable", () => {
    for (const state of [...LIFECYCLE_STATES, "release_committed", "stopped"]) insert(state);
    const rows = committed(), stateSchema = z.enum(LIFECYCLE_STATES);
    expect(rows.slice(0, LIFECYCLE_STATES.length).map(value => stateSchema.parse(value))).toEqual([...LIFECYCLE_STATES]);
    expect(stateSchema.safeParse(rows.at(-2)).success).toBe(false); expect(stateSchema.safeParse(rows.at(-1)).success).toBe(false);
    expect(Reflect.set(LIFECYCLE_NEXT.prepared, 0, "done")).toBe(false);
    expect(Reflect.set(LIFECYCLE_NEXT, "released", ["done"])).toBe(false);
    expect(LIFECYCLE_NEXT.prepared).toEqual(["release_intent", "stop_intent", "failed_serving", "unknown"]);
    expect(committed()).toEqual(rows);
  });
});
