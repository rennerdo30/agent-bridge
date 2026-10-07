import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { TransferManager } from "../src/network/transfers.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.each(["chunk", "resume"])("closes the partial file when its journal cannot open during %s", async (operation) => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-transfer-resources-")));
  const responses: Record<string, unknown>[] = [];
  const manager = new TransferManager(home, {
    supports: () => true, send: async (_remote, response) => { responses.push(response); },
    validSender: () => true, localPeer: () => ({ id: "receiver", name: "receiver", agent: "opencode", cwd: home }),
    notify: () => {}, legacy: async () => { throw new Error("unused"); },
  }, nullLogger);
  let partial: FileHandle | undefined;
  try {
    const id = randomUUID();
    const offer = { kind: "request", op: "offer", id, rid: randomUUID(), from: { id: "sender", name: "sender", agent: "codex" }, to: "receiver", entries: [{ kind: "file", path: "result.bin", size: 1 }] };
    await manager.handle(offer, "remote", "paired");
    expect(responses.at(-1)).not.toHaveProperty("error");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".sha256")) throw new Error("journal temporarily unavailable");
      const file = await actual.open(...args);
      if (String(args[0]).endsWith(".part")) partial = file;
      return file;
    });
    const data = Buffer.from("x");
    await manager.handle(operation === "resume" ? { ...offer, rid: randomUUID() } : {
      kind: "request", op: "chunk", id, rid: randomUUID(), index: 0, offset: 0,
      data: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex"),
    }, "remote", "paired");
    expect(responses.at(-1)?.error).toContain("journal temporarily unavailable");
    expect(partial).toBeDefined();
    expect(partial!.fd).toBe(-1);
  } finally {
    manager.close();
    await partial?.close();
    vi.mocked(open).mockReset();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(actual.open);
    rmSync(home, { recursive: true, force: true });
  }
});
