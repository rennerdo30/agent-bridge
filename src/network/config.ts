import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { CONFIG_FILE_NAME } from "../core/constants.js";
import { isRecord, mergeStoreFields, readJsonStore, writeJsonStore } from "../core/json-store.js";
import { z } from "zod";
import { DEFAULT_NETWORK_PORT, MAX_NETWORK_HOST_CHARS, MAX_NETWORK_NAME_CHARS, MAX_PORT, NETWORK_NAME_PATTERN } from "./constants.js";
const MAX_FETCH_ROOT_CHARS = 1_024;
const MAX_FETCH_ROOTS = 128;

export const networkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().regex(NETWORK_NAME_PATTERN).default(hostname().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_NETWORK_NAME_CHARS) || "host"),
  bind: z.string().min(1).max(MAX_NETWORK_HOST_CHARS).default("127.0.0.1"),
  port: z.number().int().min(0).max(MAX_PORT).default(DEFAULT_NETWORK_PORT),
  discovery: z.boolean().default(false),
  maxTransferBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  fetchRoots: z.array(z.string().min(1).max(MAX_FETCH_ROOT_CHARS).refine(isAbsolute, "fetch roots must be absolute paths")).max(MAX_FETCH_ROOTS).optional(),
});

export type NetworkConfig = z.infer<typeof networkConfigSchema>;
export const DEFAULT_NETWORK_CONFIG = networkConfigSchema.parse({});

export function parseNetworkConfig(value: unknown): NetworkConfig | undefined {
  const result = networkConfigSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Preserve unrelated and future fields; version checks and atomic replacement belong to the store. */
export function writeNetworkConfig(home: string, value: unknown): NetworkConfig {
  const config = networkConfigSchema.parse(value);
  const path = join(home, CONFIG_FILE_NAME);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { network: config }), previous);
  return config;
}
