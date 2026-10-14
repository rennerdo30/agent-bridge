/**
 * A request body (or stdin) as UTF-8 text, limited by its byte length. Chunks are joined before decoding, so a
 * multi-byte character split across chunks stays intact (AB-244).
 */
export async function readBodyText(stream: AsyncIterable<unknown>, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
