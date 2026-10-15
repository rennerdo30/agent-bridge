import { z } from "zod";

// Pinned hello parser from v0.30.20; link.ts blob 34d40b8d242bb1dfbfe402fc4d081217afc26f37.
// v0.30.17 ships the same link.ts blob, with the older agent enum below.
// Keep all constants and identity/peer schemas independent of current production code.
const MAX_METADATA_CHARS = 4_096, MAX_ID_CHARS = 128, MAX_HOP_COUNT = 100, MAX_EXTENSION_HANDLERS = 8;
const MAX_NETWORK_PEERS = 256, NETWORK_VERSION = 1;
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const keySchema = z.string().regex(/^[0-9a-f]{64}$/);
const publicIdentitySchema = z.object({ id: z.uuid(), name: z.string().regex(NETWORK_NAME_PATTERN), fingerprint: keySchema });
function legacyHello(AGENT_KINDS: readonly string[]) {
  const textId = z.string().min(1).max(MAX_ID_CHARS);
  const peerSchema = z.object({
    id: textId, name: z.string().regex(NETWORK_NAME_PATTERN), agent: z.enum(AGENT_KINDS),
    cwd: z.string().max(MAX_METADATA_CHARS), pid: z.number().int().nonnegative(), agentPid: z.number().int().nonnegative().nullable(),
    sessionId: z.string().max(MAX_METADATA_CHARS).nullable(), startedAt: z.number().nonnegative(), autoWake: z.boolean(),
    wakeOnDirect: z.boolean().optional(), wakeAvailable: z.boolean().optional(), wakeMaxHops: z.number().int().min(0).max(MAX_HOP_COUNT).optional(),
    activity: z.enum(["busy", "idle"]).nullable().optional(), version: z.string().max(MAX_ID_CHARS).optional(), jobAgent: z.enum(AGENT_KINDS).optional(),
    jobParent: z.string().max(MAX_METADATA_CHARS).optional(), jobTitle: z.string().max(MAX_METADATA_CHARS).optional(),
    parentJob: z.string().max(MAX_METADATA_CHARS).optional(), rootSession: z.string().max(MAX_METADATA_CHARS).optional(),
    rootName: z.string().max(MAX_METADATA_CHARS).optional(), subagent: z.boolean().optional(), title: z.string().max(MAX_METADATA_CHARS).optional(),
    projectGroup: z.string().min(1).max(MAX_METADATA_CHARS).optional(), projectAddress: z.string().min(1).max(MAX_METADATA_CHARS).optional(),
    projectMain: z.boolean().optional(), unavailable: z.boolean().optional(),
  });
  const peersSchema = z.array(peerSchema).max(MAX_NETWORK_PEERS).refine((peers) => new Set(peers.map((p) => p.name)).size === peers.length && new Set(peers.map((p) => p.id)).size === peers.length);
  return publicIdentitySchema.extend({ type: z.literal("hello"), v: z.literal(NETWORK_VERSION), peers: peersSchema, echo: z.boolean().optional(), receipts: z.boolean().optional(), capabilities: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_EXTENSION_HANDLERS).optional() });
}
export const v03020HelloSchema = legacyHello(["claude", "codex", "opencode", "antigravity", "muse", "other"]);
export const v03017HelloSchema = legacyHello(["claude", "codex", "opencode", "antigravity", "other"]);
