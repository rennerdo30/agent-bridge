import { deliveryFailure } from "../src/mcp/delivery-evidence.js";

/** Failure-only bounded response classification. Never return response text. */
export async function httpFailureEvidence(response: Response) {
  if (response.ok) return { status: response.status, category: "none" };
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, category: "invalid_response" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("diagnostic deadline")), 250); });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    let complete = false;
    for (let reads = 0; reads < 16; reads++) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) return { status: response.status, category: "invalid_response" };
      size += chunk.value.byteLength;
      if (size > 4096) return { status: response.status, category: "oversized_response" };
      chunks.push(chunk.value);
    }
    if (!complete) return { status: response.status, category: "oversized_response" };
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
    const failure = deliveryFailure({ message: error });
    const category = /did not attest the exact native identity/.test(error) ? "native_attestation_text" : /lacks schema14 local mailbox provenance/.test(error) ? "mailbox_attestation_text" :
      /broker speaks protocol/.test(error) ? "protocol_version_text" : error.includes("could not connect to or start") ? "discovery_unavailable" : error.includes("connection to broker closed") ? "connection_closed" :
      error.includes("timed out") ? "timeout" : /unauthorized|authentication/i.test(error) ? "auth_rejection" : failure.reason && failure.reason !== "other" ? failure.reason : "unclassified";
    return { status: response.status, category };
  } catch { return { status: response.status, category: "invalid_response" }; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
