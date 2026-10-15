export interface NativeRequestOptions {
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}
export interface NativePinnedTransport {
  reserve(requestId: string): void;
  request(url: string, init: NativeRequestOptions, pins: string[], requestId: string): Promise<NativeResponse>;
  cancel(requestId: string): void;
}

let sequence = 0;
const MAX_BODY = 512 * 1024;
const TIMEOUT = 10_000;
export function createPinnedRequest(
  getNative: () => NativePinnedTransport,
  makeResponse: (body: string | null, init: ResponseInit) => Response = (body, init) => new Response(body, init),
): (url: string, init: RequestInit, pins: readonly string[]) => Promise<Response> {
  return async (input, init, pins) => {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Pinned transport requires HTTPS");
    // SHA-256 base64url is exactly 43 characters, with canonical final sextet.
    if (!Array.isArray(pins) || pins.length < 1 || pins.length > 2 ||
      pins.some(pin => !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(pin)) || new Set(pins).size !== pins.length) {
      throw new Error("Invalid TLS pin set");
    }
    if (init.body != null && typeof init.body !== "string") throw new Error("Pinned transport requires a string body");
    if (init.body && new TextEncoder().encode(init.body).length > 32 * 1024) throw new Error("Request body too large");
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE"].includes(method) || (method === "GET" && init.body != null)) throw new Error("Unsupported request method");
    if (init.redirect && init.redirect !== "error") throw new Error("Pinned transport refuses redirects");
    if (init.credentials && init.credentials !== "omit") throw new Error("Pinned transport requires omitted cookies");
    const headers = new Headers(init.headers);
    for (const name of ["cookie", "host", "connection", "proxy-authorization"]) {
      if (headers.has(name)) throw new Error("Unsupported request header");
    }
    headers.set("cache-control", "no-store");
    const options: NativeRequestOptions = { method, headers: Object.fromEntries(headers.entries()), body: init.body as string | null ?? null };
    if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    const native = getNative();
    const id = `${Date.now()}-${++sequence}`;
    // Synchronous reservation makes abort-before-native-dispatch fail closed.
    native.reserve(id);
    const result = await new Promise<NativeResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, response?: NativeResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(response!);
      };
      const cancel = (error: Error) => {
        try { native.cancel(id); } catch { /* Failure still rejects; never changes transport. */ }
        finish(error);
      };
      const onAbort = () => cancel(new DOMException("Request aborted", "AbortError"));
      const timer = setTimeout(() => cancel(new Error("Pinned request timed out")), TIMEOUT);
      init.signal?.addEventListener("abort", onAbort, { once: true });
      // Close the abort race between the first signal check and listener registration.
      if (init.signal?.aborted) { onAbort(); return; }
      Promise.resolve().then(() => {
        if (settled) throw new DOMException("Request aborted", "AbortError");
        return native.request(url.href, options, [...pins], id);
      }).then(response => finish(undefined, response), error => finish(error));
    });
    if (result.url !== url.href || result.status >= 300 && result.status < 400) throw new Error("Pinned transport refused redirect");
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
      typeof result.body !== "string" || new TextEncoder().encode(result.body).length > MAX_BODY) throw new Error("Invalid pinned response");
    const response = makeResponse([204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status, headers: result.headers });
    // Synthetic Response defaults to an empty URL; preserve the authenticated URL.
    Object.defineProperties(response, { url: { value: result.url }, redirected: { value: false } });
    return response;
  };
}
