import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CONFIG_FILE_NAME } from "../core/constants.js";
import { isRecord, mergeStoreFields, readJsonStore, writeJsonStore } from "../core/json-store.js";
import { z } from "zod";
import { CODING_AGENTS } from "../core/protocol.js";
import { DEFAULT_NETWORK_PORT, MAX_NETWORK_HOST_CHARS, MAX_NETWORK_NAME_CHARS, MAX_PORT, NETWORK_NAME_PATTERN } from "./constants.js";
const MAX_FETCH_ROOT_CHARS = 1_024;
const MAX_FETCH_ROOTS = 128;

export const networkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().regex(NETWORK_NAME_PATTERN).default(hostname().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_NETWORK_NAME_CHARS) || "host"),
  bind: z.string().min(1).max(MAX_NETWORK_HOST_CHARS).default("127.0.0.1"),
  port: z.number().int().min(0).max(MAX_PORT).default(DEFAULT_NETWORK_PORT),
  discovery: z.boolean().default(false),
  remoteJobs: z.object({
    enabled: z.boolean().default(false),
    allowRoots: z.array(z.string().min(1).max(4_096)).max(50).default([]),
    agents: z.array(z.enum(CODING_AGENTS)).max(3).default([]),
    /** Pair names explicitly permitted to request jobs; no pair is trusted implicitly. */
    allowPeers: z.array(z.string().regex(NETWORK_NAME_PATTERN)).max(50).default([]),
  }).default({ enabled: false, allowRoots: [], agents: [], allowPeers: [] }),
  maxTransferBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  fetchRoots: z.array(z.string().min(1).max(MAX_FETCH_ROOT_CHARS).refine(isAbsolute, "fetch roots must be absolute paths")).max(MAX_FETCH_ROOTS).optional(),
});

export type NetworkConfig = z.infer<typeof networkConfigSchema>;
export const DEFAULT_NETWORK_CONFIG = networkConfigSchema.parse({});

export function parseNetworkConfig(value: unknown): NetworkConfig | undefined {
  const result = networkConfigSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Election reads the shared configuration without repairing or rewriting owner files. */
export function readNetworkConfig(home: string, fallback: NetworkConfig): NetworkConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(join(home, CONFIG_FILE_NAME), "utf8"));
    return isRecord(value) ? parseNetworkConfig(value.network) ?? fallback : fallback;
  } catch { return fallback; }
}

/** Preserve unrelated and future fields; version checks and atomic replacement belong to the store. */
export function writeNetworkConfig(home: string, value: unknown): NetworkConfig {
  const config = networkConfigSchema.parse(value);
  const path = join(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { network: config }), previous);
  return config;
}
