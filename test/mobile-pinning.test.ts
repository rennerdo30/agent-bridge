import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MobileClient, parseQr, type StoredDevice, type WireFetch, type WireResponse } from "../apps/mobile/src/client.js";
import { gatewayTransport } from "../apps/mobile/src/transport.js";
import { MobileStore } from "../src/mobile/store.js";
import { parseMobileConfig } from "../src/mobile/config.js";
import type { Credentials } from "../src/mobile/contract.js";

const origin = "https://192.168.1.235:8443", pin = createHash("sha256").update("fixture-spki").digest("base64url"), next = createHash("sha256").update("fixture-next-spki").digest("base64url");
const at = Date.now();
function qr() { return { v: 2, pcId: "fixture-pc", invitationId: randomUUID(), origin, origins: [origin], pins: [pin, next], nonce: "q".repeat(43), expiresAt: at + 120_000 }; }
function response(url: string, body: unknown, status = 200): WireResponse { return { url, status, ok: status < 300, redirected: false, text: async () => JSON.stringify(body) }; }
const init: Parameters<WireFetch>[1] = { method: "GET", headers: {}, redirect: "error", credentials: "omit", cache: "no-store", signal: new AbortController().signal };
const credentials: Credentials = { pcId: "fixture-pc", deviceId: "fixture-device", sessionId: "fixture-session", accessToken: "a".repeat(43), refreshToken: "r".repeat(43), csrfToken: "c".repeat(43), accessExpiresAt: at + 300_000, refreshExpiresAt: at + 30 * 86400_000, capabilities: [], scopes: [] };
describe("pinned mobile pairing and transport selection", () => {
  it("parses v2 current+next pins and legacy v1; refuses missing/empty/noncanonical/extra pins and HTTP", () => {
    expect(parseQr(JSON.stringify(qr()), at).pins).toEqual([pin, next]);
    const { pins: _, ...legacy } = qr(); expect(parseQr(JSON.stringify({ ...legacy, v: 1 }), at)).toEqual({ ...legacy, v: 1 });
    for (const pins of [undefined, [], ["bad"], [pin, pin], [pin, next, pin], [pin.slice(0, -1) + "B"]]) expect(() => parseQr(JSON.stringify({ ...qr(), pins }), at)).toThrow();
    expect(() => parseQr(JSON.stringify({ ...qr(), v: 1 }), at)).toThrow();
    expect(() => parseQr(JSON.stringify({ ...qr(), origin: "http://192.168.1.235:8443", origins: ["http://192.168.1.235:8443"] }), at)).toThrow();
  });
  it("emits v2 only for pinned registries, without changing v1 invitations", () => {
    const pinned = new MobileStore(":memory:", "fixture-pc", origin, () => at, [], [pin, next]), legacy = new MobileStore(":memory:", "fixture-pc", origin, () => at);
    try { expect(pinned.invite()).toMatchObject({ v: 2, pins: [pin, next] }); expect(legacy.invite()).toMatchObject({ v: 1 }); expect(legacy.invite()).not.toHaveProperty("pins"); } finally { pinned.close(); legacy.close(); }
  });
  it("accepts pinned config exclusively; supplied cert/key config is unchanged", () => {
    const listener = { origin, bindAddress: "192.168.1.235", port: 8443, tls: "pinned" }, config = { enabled: true, pcId: "fixture-pc", origins: [origin], listeners: [listener] };
    expect(parseMobileConfig(config)).toEqual(config);
    expect(parseMobileConfig({ ...config, listeners: [{ ...listener, certFile: "/secret/cert", keyFile: "/secret/key" }] })).toEqual({ enabled: true, invalid: true });
    expect(parseMobileConfig({ ...config, listeners: [{ ...listener, tls: "insecure" }] })).toEqual({ enabled: true, invalid: true });
  });
  it("never falls back after pinned rejection, missing native module or empty pins; legacy uses unpinned only", async () => {
    const fallback = vi.fn<WireFetch>(async url => response(url, {})), pinned = vi.fn<WireFetch>(async () => { throw new Error("wrong pin or unavailable module"); });
    const wire = gatewayTransport(fallback, pinned);
    await expect(wire(origin, init, [pin])).rejects.toThrow("wrong pin"); expect(fallback).not.toHaveBeenCalled();
    expect(() => wire(origin, init, [])).toThrow("invalid pins"); expect(fallback).not.toHaveBeenCalled();
    await wire(origin, init); expect(fallback).toHaveBeenCalledOnce(); expect(pinned).toHaveBeenCalledOnce();
  });
  it("routes hello, claim, issuance, me, snapshot and refresh through pins and persists them with credentials", async () => {
    const pinsSeen: (readonly string[] | undefined)[] = [], secure = { load: vi.fn(async () => null as StoredDevice | null), save: vi.fn(async (_device: StoredDevice) => {}), clear: vi.fn(async () => {}) };
    const wire: WireFetch = async (url, _init, pins) => {
      pinsSeen.push(pins); const path = new URL(url).pathname;
      if (path.endsWith("/hello")) return response(url, { apiVersion: 1, transport: "private-https", pinning: true });
      if (path.endsWith("/claims")) return response(url, { claimId: "claim", claimToken: "t".repeat(43), comparisonCode: "123456", expiresAt: at + 120_000 });
      if (path.endsWith("/claim")) return response(url, { state: "approved", credentials });
      if (path.endsWith("/refresh")) return response(url, { ...credentials, accessToken: "b".repeat(43) });
      if (path.endsWith("/me")) return response(url, credentials);
      return response(url, { apiVersion: 1, pcId: credentials.pcId, epoch: "epoch", cursor: "cursor", sampledAt: at, stale: false, sourceState: "ready", sessions: [], jobs: [], questions: [], pages: {}, capabilities: [] });
    };
    const client = new MobileClient(wire, secure, randomUUID, () => at);
    await client.beginPairing(parseQr(JSON.stringify(qr()), at), "fixture phone", "ios"); await client.pollPairing(); await client.reconnect();
    expect(client.state.connection).toBe("ready"); expect(pinsSeen.length).toBeGreaterThanOrEqual(8); expect(pinsSeen.every(pins => JSON.stringify(pins) === JSON.stringify([pin, next]))).toBe(true);
    for (const [saved] of secure.save.mock.calls) expect(saved).toMatchObject({ pins: [pin, next], pinning: true });
  });
  it("rejects corrupt pinned credentials before any request and refuses unpinned hello for a pinned device", async () => {
    const wire = vi.fn<WireFetch>(async url => response(url, { apiVersion: 1, transport: "private-https", pinning: false }));
    const stored: StoredDevice = { origins: [origin], preferredOrigin: origin, credentials, pinning: true };
    const secure = { load: async () => stored, save: async () => {}, clear: async () => {} };
    await expect(new MobileClient(wire, secure, randomUUID, () => at).initialize()).rejects.toThrow("invalid pins"); expect(wire).not.toHaveBeenCalled();
    stored.pins = [pin]; await expect(new MobileClient(wire, secure, randomUUID, () => at).initialize()).rejects.toThrow("unreachable"); expect(wire).toHaveBeenCalledOnce(); expect(wire.mock.calls[0]?.[2]).toEqual([pin]);
  });
  it("refuses pinned redirect responses before accepting hello or sending a credential", async () => {
    const wire = vi.fn<WireFetch>(async url => response(url, {}, 302)), client = new MobileClient(wire, { load: async () => null, save: async () => {}, clear: async () => {} }, randomUUID, () => at);
    await expect(client.beginPairing(parseQr(JSON.stringify(qr()), at), "fixture", "ios")).rejects.toThrow("unreachable"); expect(wire).toHaveBeenCalledOnce(); expect(wire.mock.calls[0]?.[1].headers).not.toHaveProperty("authorization");
  });
});
