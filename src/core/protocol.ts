/**
 * Broker wire protocol: newline-delimited JSON frames over a named pipe (Windows) or Unix socket.
 *
 *   client -> broker   {"t":"req","id":1,"op":"send","args":{...}}
 *   broker -> client   {"t":"res","id":1,"ok":true,"result":{...}}   or   {"t":"res","id":1,"ok":false,"error":{...}}
 *   broker -> client   {"t":"evt","ev":"message","data":{...}}
 */

export type AgentKind = "claude" | "codex" | "opencode" | "other";
export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "opencode", "other"];
/** Agents that agent-bridge can run headlessly (delegation / subagents). */
export type CodingAgent = Exclude<AgentKind, "other">;
export const CODING_AGENTS: readonly CodingAgent[] = ["claude", "codex", "opencode"];

/** Broadcast target. */
export const BROADCAST = "*";

export interface PeerInfo {
  /** Unique per process. */
  id: string;
  /** Stable, human-friendly address such as "codex-myrepo". Unique among live peers. */
  name: string;
  agent: AgentKind;
  cwd: string;
  pid: number;
  /** PID of the process that spawned this MCP server (normally the agent CLI). */
  agentPid: number | null;
  /** Agent session / thread id, when known (learned from hooks). */
  sessionId: string | null;
  startedAt: number;
  autoWake: boolean;
  /** Whether the agent is working on a turn right now, when known (reported by hooks). */
  activity?: PeerActivity | null;
  /** agent-bridge version of this peer. */
  version?: string;
}

export type PeerActivity = "busy" | "idle";

export interface MessageAddress {
  id: string;
  name: string;
  agent: AgentKind;
}

export interface BridgeMessage {
  id: string;
  from: MessageAddress;
  /** Target as given by the sender: a peer name, peer id, agent kind or "*". */
  to: string;
  /** Resolved recipient name (one row per recipient for broadcasts). */
  recipient: string;
  conversationId: string;
  replyTo: string | null;
  /** Number of agent-to-agent hops in this conversation; used for loop protection. */
  hop: number;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface HelloArgs {
  protocol: number;
  /** Shared secret from ~/.agent-bridge/token. */
  token: string;
  peer: Omit<PeerInfo, "name"> & { name: string };
}
export interface HelloResult {
  brokerPid: number;
  /** Final name; may carry a suffix if the requested name was taken. */
  name: string;
  peers: PeerInfo[];
}

export interface SendArgs {
  to: string;
  body: string;
  conversationId?: string;
  replyTo?: string;
}
export interface SendResult {
  messages: BridgeMessage[];
  /** Names of recipients that were online and received the message immediately. */
  deliveredTo: string[];
  /** Names (or agent:<kind>) of recipients that were offline; the message waits for them. */
  queuedFor: string[];
}

export interface AckArgs {
  ids: string[];
}

export interface PendingArgs {
  limit?: number;
}

export interface UpdatePeerArgs {
  sessionId?: string | null;
  autoWake?: boolean;
  cwd?: string;
  activity?: PeerActivity;
  /** Requested new name; the broker may add a suffix if it is taken. */
  name?: string;
}

export interface AuthArgs {
  protocol: number;
  token: string;
}

export interface RequestMap {
  auth: [AuthArgs, { brokerPid: number }];
  hello: [HelloArgs, HelloResult];
  send: [SendArgs, SendResult];
  peers: [Record<string, never>, PeerInfo[]];
  ack: [AckArgs, { acked: number }];
  pending: [PendingArgs, BridgeMessage[]];
  updatePeer: [UpdatePeerArgs, PeerInfo];
  ping: [Record<string, never>, { brokerPid: number; protocol: number }];
}
export type Op = keyof RequestMap;

export interface RequestFrame<O extends Op = Op> {
  t: "req";
  id: number;
  op: O;
  args: RequestMap[O][0];
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ErrorCode =
  | "bad_request"
  | "not_registered"
  | "ambiguous_target"
  | "unknown_target"
  | "protocol_mismatch"
  | "unauthorized"
  | "too_large"
  | "internal";

export type ResponseFrame =
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: ErrorPayload };

export interface EventMap {
  message: BridgeMessage;
  peer_joined: PeerInfo;
  peer_left: PeerInfo;
}
export type EventName = keyof EventMap;

export interface EventFrame<E extends EventName = EventName> {
  t: "evt";
  ev: E;
  data: EventMap[E];
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BridgeError";
  }
  toPayload(): ErrorPayload {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Splits an incoming byte stream into JSON frames. */
export class FrameDecoder {
  private buffer = "";
  constructor(private readonly maxBytes: number) {}

  push(chunk: string): Frame[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
      this.buffer = "";
      throw new BridgeError("too_large", "frame exceeds maximum size");
    }
    const frames: Frame[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      frames.push(JSON.parse(line) as Frame);
    }
    return frames;
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + "\n";
}
