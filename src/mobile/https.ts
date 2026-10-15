import { createServer, type Server, type ServerOptions } from "node:https";
import type { MobileGateway } from "./gateway.js";

/** No listen() here. Owner supplies normal trusted TLS certificates and private network binding. */
export function createMobileHttpsServer(gateway: MobileGateway, tls: Pick<ServerOptions, "key" | "cert">, pinning = false): Server {
  if (!tls.key || !tls.cert) throw new Error("Owner-provisioned trusted TLS certificate/key required");
  const server = createServer({ ...tls, minVersion: "TLSv1.2" }, (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      // Reject duplicate security headers; never combine their authorities.
      if (Array.isArray(value)) { res.writeHead(400, { "cache-control": "no-store" }); res.end(); return; }
      headers[key] = value;
    }
    for (const header of ["authorization", "host", "origin", "idempotency-key", "x-mobile-csrf", "x-mobile-view", "content-type"])
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === header).length > 1) { res.writeHead(400); res.end(); return; }
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024) { res.writeHead(413, { "cache-control": "no-store" }); res.end(); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => {
      void gateway.handle({ method: req.method ?? "", path: req.url ?? "", headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
        authority: req.headers.host ?? "", tls: true, pinning, remoteAddress: req.socket.remoteAddress ?? "unknown" }).then(result => {
        const json = result.body === undefined ? "" : JSON.stringify(result.body);
        if (Buffer.byteLength(json) > 512 * 1024) { res.writeHead(413, { "cache-control": "no-store" }); res.end(JSON.stringify({ code: "response_too_large" })); return; }
        res.writeHead(result.status, result.headers); res.end(json);
      }).catch(() => { res.writeHead(503, { "cache-control": "no-store" }); res.end(JSON.stringify({ code: "unavailable" })); });
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 32;
  return server;
}

export interface MobileListenerConfig { bindAddress: string; port: number; origin: string; tls: Pick<ServerOptions, "key" | "cert">; pinning?: boolean }
/** Multiple LAN/Tailscale listeners share one registry, credentials and grants; all remain unbound. */
export function createMobileHttpsListeners(gateway: MobileGateway, configs: MobileListenerConfig[]): { config: MobileListenerConfig; server: Server }[] {
  if (configs.length < 1 || configs.length > 8) throw new Error("Supply one to eight owner-provisioned private listeners");
  return configs.map(config => {
    if (!gateway.store.origins.includes(config.origin) || !config.bindAddress || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || ["0.0.0.0", "::"].includes(config.bindAddress)) throw new Error("Exact approved private bind address/hostname and HTTPS origin required");
    return { config, server: createMobileHttpsServer(gateway, config.tls, config.pinning === true) };
  });
}
