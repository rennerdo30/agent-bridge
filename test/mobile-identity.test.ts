import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMobileIdentity, spkiPin } from "../src/mobile/identity.js";
import { readPrivateMaterial } from "../src/mobile/config.js";
import { validateMobileTls } from "../src/mobile/activation.js";

function home(): string { const root = resolve(".agent-bridge-test/mobile-identity"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "identity-")); }
const origins = ["https://192.168.1.235:8443", "https://pc.private.test:8443", "https://[fd00::235]:8443"];
describe("owner-private mobile PC identity", () => {
  it("generates one P-256 key, correct IP/DNS SANs, a self-signature and canonical SPKI hash; persists across changed origins/renewal", async () => {
    const dir = home(), identity = await loadMobileIdentity(dir, origins), key = createPrivateKey(identity.key), cert = new X509Certificate(identity.cert);
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.verify(cert.publicKey)).toBe(true); expect(cert.ca).toBe(false);
    for (const origin of origins) validateMobileTls(identity.cert, identity.key, new URL(origin).hostname);
    expect(cert.checkIP("192.168.1.235")).toBe("192.168.1.235"); expect(cert.checkHost("pc.private.test")).toBe("pc.private.test");
    expect(cert.checkIP("fd00::235")).toBe("fd00::235"); expect(cert.checkIP("192.168.1.236")).toBeUndefined();
    const pin = createHash("sha256").update(cert.publicKey.export({ format: "der", type: "spki" })).digest("base64url");
    expect(identity.pins).toEqual([pin]); expect(spkiPin(identity.key)).toBe(pin);
    const renewed = await loadMobileIdentity(dir, ["https://192.168.1.236:8443"], { now: Date.now() + 400 * 86400_000 });
    expect(renewed.key).toEqual(identity.key); expect(renewed.pins).toEqual(identity.pins);
    expect(new X509Certificate(renewed.cert).checkIP("192.168.1.236")).toBe("192.168.1.236");
    const keyFile = join(dir, "mobile-identity", "keys", readdirSync(join(dir, "mobile-identity", "keys"))[0]!);
    expect(await readPrivateMaterial(keyFile)).toEqual(identity.key);
    if (process.platform !== "win32") { expect(statSync(keyFile).mode & 0o777).toBe(0o600); expect(statSync(join(dir, "mobile-identity")).mode & 0o777).toBe(0o700); }
  }, 30_000);
  it("stages current+next pins, promotes explicitly, archives retired bytes and preserves every original state/key", async () => {
    const dir = home(), first = await loadMobileIdentity(dir, origins), staged = await loadMobileIdentity(dir, origins, { rotation: "stage" });
    expect(staged.key).toEqual(first.key); expect(staged.pins).toHaveLength(2); expect(staged.pins[0]).toBe(first.pins[0]);
    expect((await loadMobileIdentity(dir, origins)).pins).toEqual(staged.pins);
    const beforeKeys = readdirSync(join(dir, "mobile-identity", "keys")).map(name => [name, readFileSync(join(dir, "mobile-identity", "keys", name))] as const);
    const promoted = await loadMobileIdentity(dir, origins, { rotation: "promote" });
    expect(promoted.pins).toEqual([staged.pins[1]]); expect(promoted.key).not.toEqual(first.key);
    const archive = join(dir, "mobile-identity", "archive"); expect(readdirSync(archive)).toHaveLength(1); expect(readFileSync(join(archive, readdirSync(archive)[0]!))).toEqual(first.key);
    for (const [name, bytes] of beforeKeys) expect(readFileSync(join(dir, "mobile-identity", "keys", name))).toEqual(bytes);
    expect(readdirSync(join(dir, "mobile-identity", "states"))).toHaveLength(3);
  }, 45_000);
  it("denies private-file/ACL check failure without repairing or replacing an existing key", async () => {
    const dir = home(), identity = await loadMobileIdentity(dir, origins), keys = join(dir, "mobile-identity", "keys"), file = join(keys, readdirSync(keys)[0]!);
    await expect(loadMobileIdentity(dir, origins, { platform: "win32", acl: async path => path !== file })).rejects.toThrow("material_unavailable");
    expect(readFileSync(file)).toEqual(identity.key); expect(readdirSync(keys)).toHaveLength(1);
    if (process.platform !== "win32") { chmodSync(file, 0o644); await expect(loadMobileIdentity(dir, origins)).rejects.toThrow("material_unavailable"); expect(statSync(file).mode & 0o777).toBe(0o644); }
  }, 30_000);
  it("fails closed on corrupt latest state and linked source rather than generating a replacement", async () => {
    const dir = home(); await loadMobileIdentity(dir, origins);
    const states = join(dir, "mobile-identity", "states"), file = join(states, readdirSync(states)[0]!); writeFileSync(file, "{}");
    await expect(loadMobileIdentity(dir, origins)).rejects.toThrow("material_unavailable"); expect(readdirSync(join(dir, "mobile-identity", "keys"))).toHaveLength(1);
    const linkedHome = home(); symlinkSync(join(dir, "mobile-identity"), join(linkedHome, "mobile-identity"), process.platform === "win32" ? "junction" : "dir");
    await expect(loadMobileIdentity(linkedHome, origins)).rejects.toThrow("material_unavailable");
  }, 30_000);
});
