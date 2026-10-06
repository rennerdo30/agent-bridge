import { hostname } from "node:os";
import { z } from "zod";
import { DEFAULT_NETWORK_PORT, MAX_NETWORK_HOST_CHARS, MAX_NETWORK_NAME_CHARS, MAX_PORT, NETWORK_NAME_PATTERN } from "./constants.js";

export const networkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().regex(NETWORK_NAME_PATTERN).default(hostname().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_NETWORK_NAME_CHARS) || "host"),
  bind: z.string().min(1).max(MAX_NETWORK_HOST_CHARS).default("127.0.0.1"),
  port: z.number().int().min(0).max(MAX_PORT).default(DEFAULT_NETWORK_PORT),
  discovery: z.boolean().default(false),
});

export type NetworkConfig = z.infer<typeof networkConfigSchema>;
export const DEFAULT_NETWORK_CONFIG = networkConfigSchema.parse({});

export function parseNetworkConfig(value: unknown): NetworkConfig | undefined {
  const result = networkConfigSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
