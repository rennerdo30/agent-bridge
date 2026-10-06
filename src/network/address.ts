import { MAX_PORT } from "./constants.js";

export function parseNetworkAddress(address: string): { host: string; port: number } {
  const url = new URL(`tls://${address}`);
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > MAX_PORT || url.username || url.password || url.pathname || url.search || url.hash) throw new Error("expected host:port");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

