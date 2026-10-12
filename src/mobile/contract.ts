/** Pure data contract shared by the gateway and Expo client. Never import server modules into the app. */
export type Capability = "overview.read" | "chat.read" | "questions.read" | "questions.answer";
export type Platform = "android" | "ios";
export interface Grant { pcId: string; projectIds: string[]; sessionIds: string[]; jobIds: string[]; capabilities: Capability[] }
export interface Credentials {
  deviceId: string; sessionId: string; pcId: string; accessToken: string; refreshToken: string; csrfToken: string;
  accessExpiresAt: number; refreshExpiresAt: number; capabilities: Capability[]; scopes: Grant[];
}
export interface Session {
  id: string; pcId: string; generation: string; name: string; agent: string; projectId: string | null;
  activity: "busy" | "idle" | "unknown"; connection: "connected" | "offline" | "unavailable";
  parentId: string | null; chatId: string | null; sendSupported: false; sampledAt: number; version: string;
}
export interface Job {
  id: string; pcId: string; projectId: string | null; parentId: string | null; title: string;
  status: "running" | "done" | "failed" | "interrupted" | "cancelled" | "unknown";
  progress: { percent: number | null; note: string | null; at: number | null; etaAt: number | null; etaReportedAt: number | null };
  chatId: string | null; hasSteps: boolean; archived: boolean; recovered: boolean; sampledAt: number; version: string;
}
export interface Question {
  id: string; kind: "question"; pcId: string; projectId: string; title: string; context: string; topic: string;
  options: { id: string; label: string; consequence: string; recommended: boolean }[];
  links: { kind: "issue" | "file" | "commit" | "artifact" | "diff"; display: string }[];
  blocking: boolean; blocks: string; meanwhile: string; destructive: boolean; authorization: boolean;
  urgency: "normal" | "urgent"; declaredDefault: { option: string; deadline: number } | null;
  status: "open" | "answered" | "cancelled" | "superseded"; askedAt: number; version: string;
  answer: { text: string; option?: string; at: number; source: "owner" | "declared-default"; authorLabel: string } | null;
  deliveries: { recipientLabel: string; state: string; consumedAt: number | null }[];
  dismissal: { reason: string; at: number; replacementId?: string } | null;
}
export interface ChatItem { id: string; kind: "user" | "assistant" | "tool" | "subagent"; at: number; text?: string; tool?: string; summary?: string; version: string; truncated: boolean }
export interface Page<T> { items: T[]; next: string | null; generation: string; reset: boolean; sampledAt: number; viewCursor: string }
export interface Snapshot {
  apiVersion: 1; pcId: string; epoch: string; cursor: string; sampledAt: number; stale: boolean; capabilities: Capability[];
  sessions: Session[]; jobs: Job[]; questions: Question[]; pages: { sessions: string | null; jobs: string | null; questions: string | null };
  sourceState: "ready" | "offline" | "slow" | "unavailable";
}
export interface Event {
  apiVersion: 1; epoch: string; cursor: string; type: "snapshot.required";
  resource: { kind: "snapshot"; id: string }; version: string; at: number;
}
export interface Hello { apiVersion: 1; capabilities: Capability[]; transport: "private-https"; pinning: false; send: "unsupported"; pairedPcWrites: "unsupported"; push: "configured" | "unsupported" }
export interface GatewayError { code: string; message: string; requestId: string; retryable: boolean; currentVersion?: string }
export interface PairingQr { v: 1; origin: string; origins: string[]; pcId: string; invitationId: string; nonce: string; expiresAt: number }
export interface PairingClaim { claimId: string; claimToken: string; comparisonCode: string; expiresAt: number }
export type ClaimResult = { state: "pending" | "denied" | "expired" | "issued" } | { state: "approved"; credentials: Credentials };
