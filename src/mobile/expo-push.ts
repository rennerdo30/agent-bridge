import type { PushHint, PushProvider, PushRegistration } from "./push.js";

interface ProviderReply { status: number; text(): Promise<string> }
export type ProviderFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal }) => Promise<ProviderReply>;
/** Inert Expo enhanced-security adapter. Owner injects its token; never reads keys/environment/files. */
export class ExpoPushProvider implements PushProvider {
  private windowAt = 0;
  private submitted = 0;
  constructor(private readonly accessToken: string, private readonly transport: ProviderFetch = fetch,
    private readonly now: () => number = Date.now) { if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error("Owner-provisioned Expo enhanced push security token required"); }
  private async post(path: "send" | "getReceipts", body: unknown): Promise<unknown> {
    const result = await this.transport(`https://exp.host/--/api/v2/push/${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    if (result.status !== 200) return undefined;
    const text = await result.text(); if (text.length > 32 * 1024) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  }
  async submit(registration: PushRegistration, hint: PushHint): Promise<{ state: "submitted" | "retry-later" | "device-not-registered"; ticketId?: string }> {
    // Conservative process budget: 100 messages/second, below Expo's 600/second/project limit.
    if (this.now() - this.windowAt >= 1000) { this.windowAt = this.now(); this.submitted = 0; }
    if (++this.submitted > 100) return { state: "retry-later" };
    const payload = { to: registration.expoPushToken, title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: hint.data.notificationId }, ttl: 300, channelId: "owner-updates" };
    if (Buffer.byteLength(JSON.stringify(payload)) > 4096) return { state: "retry-later" };
    const result = await this.post("send", payload) as { data?: { status?: string; id?: string; details?: { error?: string } } } | undefined;
    if (result?.data?.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    if (result?.data?.status === "ok" && typeof result.data.id === "string" && /^[\w-]{1,128}$/.test(result.data.id)) return { state: "submitted", ticketId: result.data.id };
    return { state: "retry-later" };
  }
  async receipt(ticketId: string): Promise<{ state: "provider-accepted" | "pending" | "device-not-registered" | "failed" }> {
    if (!/^[\w-]{1,128}$/.test(ticketId)) return { state: "failed" };
    const result = await this.post("getReceipts", { ids: [ticketId] }) as { data?: Record<string, { status?: string; details?: { error?: string } }> } | undefined;
    const receipt = result?.data?.[ticketId];
    if (!receipt) return { state: "pending" };
    if (receipt.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    return { state: receipt.status === "ok" ? "provider-accepted" : "failed" };
  }
}
