import { describe, expect, it, vi } from "vitest";
import { ExpoPushProvider, type ProviderFetch } from "../src/mobile/expo-push.js";

const registration = { expoPushToken: "ExpoPushToken[fixture]", platform: "android" as const, projectId: "fixture-project", environment: "development" as const };
const hint = { title: "agent-bridge" as const, body: "Open the app to review an update" as const, data: { v: 1 as const, notificationId: "opaque-id" }, ttl: 300 as const };
describe("unconfigured Expo provider seam", () => {
  it("sends a generic opaque hint to fixed HTTPS with enhanced auth and no redirects", async () => {
    const transport = vi.fn<ProviderFetch>(async () => ({ status: 200, text: async () => JSON.stringify({ data: { status: "ok", id: "ticket" } }) }));
    const provider = new ExpoPushProvider("fixture-provider-token", transport);
    expect(await provider.submit(registration, hint)).toEqual({ state: "submitted", ticketId: "ticket" });
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe("https://exp.host/--/api/v2/push/send"); expect(request.redirect).toBe("error"); expect(request.headers.authorization).toBe("Bearer fixture-provider-token");
    const body = JSON.parse(request.body); expect(body.data).toEqual({ v: 1, notificationId: "opaque-id" });
    expect(body).not.toHaveProperty("projectId"); expect(request.body).not.toContain("fixture-provider-token");
  });
  it("distinguishes provider receipts from phone delivery and invalid registrations", async () => {
    let reply: unknown = { data: { ticket: { status: "ok" } } };
    const provider = new ExpoPushProvider("fixture-token", async () => ({ status: 200, text: async () => JSON.stringify(reply) }));
    expect(await provider.receipt("ticket")).toEqual({ state: "provider-accepted" });
    reply = { data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } } }; expect(await provider.receipt("ticket")).toEqual({ state: "device-not-registered" });
    reply = { data: {} }; expect(await provider.receipt("ticket")).toEqual({ state: "pending" });
    reply = { data: { status: "error", details: { error: "DeviceNotRegistered" } } }; expect(await provider.submit(registration, hint)).toEqual({ state: "device-not-registered" });
  });
  it("bounds provider traffic and leaves ambiguous requests to caller recovery", async () => {
    let at = 1000;
    const transport = vi.fn<ProviderFetch>(async () => ({ status: 429, text: async () => "{}" }));
    const provider = new ExpoPushProvider("fixture-token", transport, () => at);
    for (let i = 0; i < 101; i++) expect(await provider.submit(registration, hint)).toEqual({ state: "retry-later" });
    expect(transport).toHaveBeenCalledTimes(100); at += 1000; await provider.submit(registration, hint); expect(transport).toHaveBeenCalledTimes(101);
    const lost = new ExpoPushProvider("fixture-token", async () => { throw new Error("fixture ambiguous timeout"); });
    await expect(lost.submit(registration, hint)).rejects.toThrow("fixture ambiguous timeout");
  });
});
