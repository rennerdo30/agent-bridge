import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Platform, Question } from "./contract.js";
import { MobileFault, MobileStore, type Device } from "./store.js";

export interface PushRegistration { expoPushToken: string; platform: Platform; projectId: string; environment: "development" | "production" }
export interface PushHint { title: "agent-bridge"; body: "Open the app to review an update"; data: { v: 1; notificationId: string }; ttl: 300 }
export interface PushProvider {
  /** Implementations MUST enforce their own finite transport/body-read deadline on every call.
   * Core broker teardown has an independent five-second mobile-disposal bound and never waits indefinitely.
   * Timeout/ambiguous provider outcomes must not trigger blind submission retries or acceptance claims. */
  submit(registration: PushRegistration, hint: PushHint): Promise<{ state: "submitted" | "retry-later" | "device-not-registered"; ticketId?: string }>;
  receipt?(ticketId: string): Promise<{ state: "provider-accepted" | "pending" | "device-not-registered" | "failed" }>;
}
interface Subscription { iv: string; tag: string; ciphertext: string }
interface HintRecord { id: string; deviceId: string; questionId: string; expiresAt: number }
/** Provider/encryption key are injected by owner provisioning; no provider or keys are configured here. */
export class MobilePush {
  constructor(private readonly store: MobileStore, private readonly provider?: PushProvider, private readonly encryptionKey?: Uint8Array,
    private readonly projectId?: string, private readonly environment?: PushRegistration["environment"]) {
    if (encryptionKey && encryptionKey.byteLength !== 32) throw new Error("Push encryption key must be 256 bits");
  }
  get configured(): boolean { return !!(this.provider && this.encryptionKey && this.projectId && this.environment); }
  register(device: Device, registration: PushRegistration): { state: string } {
    if (!this.configured) throw new MobileFault(409, "push_unsupported");
    if (registration.projectId !== this.projectId || registration.environment !== this.environment || registration.platform !== device.platform) throw new MobileFault(403, "push_project_mismatch");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.encryptionKey!, iv);
    cipher.setAAD(Buffer.from(device.id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(registration)), cipher.final()]);
    this.store.put("push", device.id, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") } satisfies Subscription);
    return { state: "registered" };
  }
  remove(deviceId: string): void { this.store.remove("push", deviceId); }
  async notify(question: Question, current: () => Promise<Question | undefined>): Promise<{ state: string }[]> {
    if (!this.configured || question.pcId !== this.store.pcId) return [];
    const results: { state: string }[] = [];
    for (const device of this.store.list<Device>("device")) {
      const q = await current();
      const active = this.store.get<Device>("device", device.id);
      if (!q || q.status !== "open" || !active || active.revoked || !this.store.can(active, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) continue;
      const subscription = this.store.get<Subscription>("push", active.id); if (!subscription) continue;
      const dedupe = `${active.id}:${q.id}:${q.askedAt}`;
      if (this.store.get("push-dedupe", dedupe)) continue;
      const id = randomUUID();
      this.store.put("hint", id, { id, deviceId: active.id, questionId: q.id, expiresAt: this.store.now() + 300_000 } satisfies HintRecord);
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey!, Buffer.from(subscription.iv, "base64"));
      decipher.setAAD(Buffer.from(active.id)); decipher.setAuthTag(Buffer.from(subscription.tag, "base64"));
      const registration = JSON.parse(Buffer.concat([decipher.update(Buffer.from(subscription.ciphertext, "base64")), decipher.final()]).toString()) as PushRegistration;
      // Reserve before dispatch; provider ambiguity is not a reason to duplicate a hint.
      this.store.put("push-dedupe", dedupe, { state: "unconfirmed" });
      try {
        const result = await this.provider!.submit(registration, { title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: id }, ttl: 300 });
        if (result.state === "device-not-registered") this.remove(active.id);
        this.store.put("push-dedupe", dedupe, { state: result.state }); results.push({ state: result.state });
      } catch { results.push({ state: "unconfirmed" }); }
    }
    return results; // Provider submission never means device delivery, consumption or acceptance.
  }
  resolve(device: Device, id: string, questions: Question[]): { questionId: string } {
    const hint = this.store.get<HintRecord>("hint", id), q = hint && questions.find(q => q.id === hint.questionId);
    if (!hint || hint.deviceId !== device.id || hint.expiresAt <= this.store.now() || !q || !this.store.can(device, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) throw new MobileFault(410, "notification_gone");
    return { questionId: q.id };
  }
}
