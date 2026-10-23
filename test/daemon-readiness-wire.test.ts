import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { FrameDecoder, encodeFrame, type RequestFrame } from "../src/core/protocol.js";
import * as identity from "../src/core/process-identity.js";
import { fixtureDaemonProbe, fixtureDaemonReadiness } from "./daemon-readiness.js";

const network = vi.hoisted(() => ({ connect: vi.fn(), directory: vi.fn() }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: network.connect }));
vi.mock("../src/core/paths.js", async original => ({ ...await original<typeof import("../src/core/paths.js")>(), ensurePrivateSocketDirectory: network.directory }));
let now: number, late: string, ops: string[], sockets: Array<EventEmitter & { destroyed: boolean }>;
let authEntered: (() => void) | undefined, releaseAuth: (() => void) | undefined;
beforeEach(() => {
  now = 0; late = ""; ops = []; sockets = []; authEntered = releaseAuth = undefined;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  network.directory.mockClear(); network.connect.mockImplementation(() => {
    const decoder = new FrameDecoder(64 * 1024);
    const socket = Object.assign(new EventEmitter(), { destroyed: false,
      setEncoding: vi.fn(), end: () => {}, destroy: () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit("close"); } },
      write: (data: string) => {
        for (const request of decoder.push(data) as RequestFrame[]) {
          ops.push(request.op);
          const answer = () => {
            if (socket.destroyed) return;
            now = late === request.op ? 1001 : now + (request.op === "auth" ? 11 : 13);
            socket.emit("data", encodeFrame({ t: "res", id: request.id, ok: true, result: request.op === "auth" ? { ok: true } : { brokerPid: 271 } }));
          };
          if (late === "suspend-auth" && request.op === "auth") { releaseAuth = answer; authEntered?.(); }
          else queueMicrotask(answer);
        }
        return true;
      },
    });
    sockets.push(socket); queueMicrotask(() => { if (!socket.destroyed) { now = late === "connect" ? 1001 : now + 7; socket.emit("connect"); } });
    return socket;
  });
  vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (_pid, signal, check) => {
    signal?.throwIfAborted(); expect(check?.()).toBe(969); now += 17; return "original-process-incarnation";
  });
});
afterEach(() => { expect(sockets.every(socket => socket.destroyed)).toBe(true); vi.restoreAllMocks(); network.connect.mockReset(); });
const probe = (budget: Parameters<typeof fixtureDaemonProbe>[2]) => fixtureDaemonProbe("owned-readonly-fixture", "fixture-only-token", budget).then(result => result.pid);

it("uses real client codec/connect/auth/ping with one decreasing deadline and no registration/effect", async () => {
  const connect = vi.spyOn(BridgeClient, "connect"), request = vi.spyOn(BridgeClient.prototype, "request");
  expect(await fixtureDaemonReadiness(probe, 1000)).toBe(271);
  expect(connect.mock.calls[0]![2]).toBe(1000);
  expect(connect.mock.calls[0]![3]).toMatchObject({ readOnlyDirectory: true });
  expect(network.directory.mock.calls[0]![2]).toBe(true);
  expect(ops).toEqual(["auth", "ping"]);
  expect(request.mock.calls.map(call => call[2])).toEqual([993, 982]);
  expect(identity.readProcessIdentity).toHaveBeenCalledOnce(); expect(now).toBe(48);
});

it.each(["connect", "auth", "ping"])("refuses late successful %s before the next stage or ready publication", async stage => {
  late = stage; const ready = vi.fn();
  const pending = fixtureDaemonReadiness(probe, 1000).then(ready);
  await expect(pending).rejects.toMatchObject({ code: "timeout" }); expect(ready).not.toHaveBeenCalled();
  expect(ops).toEqual(stage === "connect" ? [] : stage === "auth" ? ["auth"] : ["auth", "ping"]);
  expect(identity.readProcessIdentity).not.toHaveBeenCalled();
});

it("closes only the owned cold auth connection and preserves an external abort reason over its late response", async () => {
  late = "suspend-auth"; const stop = new AbortController(), failure = new Error("explicit caller cancellation"), ready = vi.fn();
  const entered = new Promise<void>(resolve => { authEntered = resolve; });
  const pending = fixtureDaemonReadiness(probe, 1000, undefined, stop.signal).then(ready);
  const rejected = expect(pending).rejects.toBe(failure);
  await entered; stop.abort(failure); await rejected; releaseAuth?.();
  expect(ready).not.toHaveBeenCalled(); expect(ops).toEqual(["auth"]); expect(identity.readProcessIdentity).not.toHaveBeenCalled();
});
