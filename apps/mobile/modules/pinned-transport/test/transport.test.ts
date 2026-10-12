import { describe, it, expect, vi, afterEach } from "vitest";
import { createPinnedRequest, type NativePinnedTransport, type NativeResponse } from "../transport";

const url = "https://192.168.1.235:8443/mobile/v1/hello";
const pin = "A".repeat(43);
const response: NativeResponse = { status: 200, headers: { "content-type": "application/json" }, body: '{"pinning":true}', url };
function fixture() {
  const native: NativePinnedTransport = { reserve: vi.fn(), request: vi.fn().mockResolvedValue(response), cancel: vi.fn() };
  const load = vi.fn(() => native);
  return { native, load, request: createPinnedRequest(load) };
}
afterEach(() => vi.useRealTimers());

describe("pinned transport boundary", () => {
  it("passes immutable pins and JSON to native and preserves Response semantics", async () => {
    const f = fixture();
    const result = await f.request(url, { method: "POST", body: "{}", headers: { authorization: "Bearer fixture" }, redirect: "error", credentials: "omit" }, [pin]);
    expect(result.url).toBe(url); expect(result.redirected).toBe(false); expect(result.ok).toBe(true);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(await result.json()).toEqual({ pinning: true });
    expect(f.native.request).toHaveBeenCalledWith(url, { method: "POST", body: "{}", headers: { authorization: "Bearer fixture", "cache-control": "no-store" } }, [pin], expect.any(String));
  });

  it.each([[], ["bad"], [pin, pin], ["A".repeat(42) + "B"], [pin, "E".repeat(43), "I".repeat(43)]].map(pins => ({ pins })))("refuses invalid pins $pins before accessing native", async ({ pins }) => {
    const f = fixture(); await expect(f.request(url, {}, pins)).rejects.toThrow("Invalid TLS pin"); expect(f.load).not.toHaveBeenCalled();
  });

  it.each(["http://192.168.1.235:8443", "https://owner:secret@192.168.1.235:8443", url + "#fragment"])("refuses unsafe URL %s", async address => {
    const f = fixture(); await expect(f.request(address, {}, [pin])).rejects.toThrow(); expect(f.load).not.toHaveBeenCalled();
  });

  it("never retries or falls back if native pin verification rejects", async () => {
    const f = fixture(); vi.mocked(f.native.request).mockRejectedValue(new Error("TLS pin mismatch"));
    await expect(f.request(url, {}, [pin])).rejects.toThrow("TLS pin mismatch"); expect(f.native.request).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the native module is absent", async () => {
    const request = createPinnedRequest(() => { throw new Error("Native module missing"); });
    await expect(request(url, {}, [pin])).rejects.toThrow("Native module missing");
  });

  it.each([301, 302, 303, 307, 308])("refuses HTTP %s without a retry", async status => {
    const f = fixture(); vi.mocked(f.native.request).mockResolvedValue({ ...response, status });
    await expect(f.request(url, {}, [pin])).rejects.toThrow("redirect"); expect(f.native.request).toHaveBeenCalledTimes(1);
  });

  it("refuses changed response URL", async () => {
    const f = fixture(); vi.mocked(f.native.request).mockResolvedValue({ ...response, url: "https://other.example/" });
    await expect(f.request(url, {}, [pin])).rejects.toThrow("redirect");
  });

  it.each([{ redirect: "follow" }, { credentials: "include" }, { body: "{}" }, { method: "PUT" }, { headers: { cookie: "fixture" } }, { method: "POST", body: "a".repeat(32769) }])("refuses unsupported request %j", async init => {
    const f = fixture(); await expect(f.request(url, init as RequestInit, [pin])).rejects.toThrow(); expect(f.load).not.toHaveBeenCalled();
  });

  it("does not dispatch an already aborted request", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.request(url, { signal: controller.signal }, [pin])).rejects.toMatchObject({ name: "AbortError" }); expect(f.load).not.toHaveBeenCalled();
  });

  it("fails closed when native reservation refuses capacity", async () => {
    const f = fixture(); vi.mocked(f.native.reserve).mockImplementation(() => { throw new Error("Request capacity exhausted"); });
    await expect(f.request(url, {}, [pin])).rejects.toThrow("capacity"); expect(f.native.request).not.toHaveBeenCalled();
  });

  it("does not dispatch when aborted immediately after reservation", async () => {
    const f = fixture(); const controller = new AbortController();
    const pending = f.request(url, { signal: controller.signal }, [pin]); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.native.reserve).toHaveBeenCalledTimes(1); expect(f.native.cancel).toHaveBeenCalledTimes(1); expect(f.native.request).not.toHaveBeenCalled();
  });

  it("cancels an in-flight native call on abort and ignores late completion", async () => {
    const f = fixture(); let resolve!: (value: NativeResponse) => void;
    vi.mocked(f.native.request).mockImplementation(() => new Promise(done => { resolve = done; }));
    const controller = new AbortController(); const pending = f.request(url, { signal: controller.signal }, [pin]);
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(f.native.cancel).toHaveBeenCalledTimes(1); resolve(response);
  });

  it("enforces a finite deadline and cancels native", async () => {
    vi.useFakeTimers(); const f = fixture(); vi.mocked(f.native.request).mockImplementation(() => new Promise(() => {}));
    const pending = f.request(url, {}, [pin]); const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10000); await rejection; expect(f.native.cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized response data", async () => {
    const f = fixture(); vi.mocked(f.native.request).mockResolvedValue({ ...response, body: "a".repeat(524289) });
    await expect(f.request(url, {}, [pin])).rejects.toThrow("Invalid pinned response");
  });

  it("represents bodyless success responses", async () => {
    const f = fixture(); vi.mocked(f.native.request).mockResolvedValue({ ...response, status: 204, body: "" });
    expect((await f.request(url, {}, [pin])).status).toBe(204);
  });
});
