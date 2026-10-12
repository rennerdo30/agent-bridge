import "reflect-metadata";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";
import { protect } from "../network/pairing.js";
import { MobileActivationFault, readPrivateMaterial, windowsPrivateAcl, type MaterialPolicy } from "./config.js";

const stateSchema = z.object({ current: z.string().uuid(), next: z.string().uuid().optional() }).strict();
type State = z.infer<typeof stateSchema>;
export interface MobileTlsIdentity { key: Buffer; cert: Buffer; pins: string[] }
/** Hash the complete SubjectPublicKeyInfo, never the raw EC point or certificate. */
export function spkiPin(key: Parameters<typeof createPublicKey>[0]): string {
  return createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64url");
}

async function privateDirectory(dir: string, policy: MaterialPolicy): Promise<void> {
  if (!isAbsolute(dir)) throw new Error();
  let component = dir;
  while (component !== parse(component).root) {
    const info = await fs.lstat(component);
    if (info.isSymbolicLink()) throw new Error();
    component = dirname(component);
  }
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || ((policy.platform ?? process.platform) === "win32"
    ? !await (policy.acl ?? windowsPrivateAcl)(dir)
    : (info.mode & 0o077) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error();
}
async function ensureDirectory(dir: string, policy: MaterialPolicy): Promise<void> {
  try { await fs.mkdir(dir, { mode: 0o700 }); protect(dir, 0o700); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  // Existing permissions are checked, never silently repaired.
  await privateDirectory(dir, policy);
}
async function writeNew(file: string, bytes: Buffer | string, policy: MaterialPolicy): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    protect(file, 0o600); // Directory was protected before creating any key bytes.
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
  await readPrivateMaterial(file, policy);
}
async function newKey(dir: string, policy: MaterialPolicy): Promise<string> {
  const id = randomUUID(), { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeNew(join(dir, "keys", id + ".pem"), privateKey.export({ type: "pkcs8", format: "pem" }), policy);
  return id;
}
async function keyBytes(dir: string, id: string, policy: MaterialPolicy): Promise<Buffer> {
  const key = await readPrivateMaterial(join(dir, "keys", id + ".pem"), policy), parsed = createPrivateKey(key);
  if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
  return key;
}
async function readState(dir: string, policy: MaterialPolicy): Promise<{ state?: State; revision: number }> {
  const names = (await fs.readdir(join(dir, "states"))).sort();
  if (names.some(name => !/^\d{12}\.json$/.test(name))) throw new Error();
  if (!names.length) return { revision: 0 };
  const last = names.at(-1)!;
  return { state: stateSchema.parse(JSON.parse((await readPrivateMaterial(join(dir, "states", last), policy)).toString("utf8"))), revision: Number(last.slice(0, 12)) };
}
async function writeState(dir: string, revision: number, state: State, policy: MaterialPolicy): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= 1e12) throw new Error();
  await writeNew(join(dir, "states", String(revision).padStart(12, "0") + ".json"), JSON.stringify(state), policy);
}

async function certificate(key: Buffer, origins: readonly string[], now: number): Promise<Buffer> {
  const hosts = [...new Set(origins.map(origin => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error();
    return url.hostname.replace(/^\[|\]$/g, "");
  }))];
  if (!hosts.length || hosts.length > 8) throw new Error();
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const privateKey = await webcrypto.subtle.importKey("pkcs8", createPrivateKey(key).export({ type: "pkcs8", format: "der" }), algorithm, false, ["sign"]);
  const publicKey = await webcrypto.subtle.importKey("spki", createPublicKey(key).export({ type: "spki", format: "der" }), algorithm, true, ["verify"]);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"), name: "CN=agent-bridge mobile", keys: { privateKey: privateKey as unknown as CryptoKey, publicKey: publicKey as unknown as CryptoKey }, signingAlgorithm: algorithm,
    notBefore: new Date(Math.floor((now - 300_000) / 1000) * 1000), notAfter: new Date(Math.floor((now + 365 * 86400_000) / 1000) * 1000),
    extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]), new SubjectAlternativeNameExtension(hosts.map(value => ({ type: isIP(value) ? "ip" as const : "dns" as const, value })))],
  }, webcrypto as unknown as Crypto);
  return Buffer.from(cert.toString("pem"));
}

const inFlight = new Map<string, Promise<MobileTlsIdentity>>();
/** Explicit activation only. Keys/states are immutable; retired private keys are copied to archive before promotion.
 * stage/promote are owner maintenance seams, never automatic rotation or a network API.
 * Certificates renew at activation with the same key so origin changes/expiry do not change the pin.
 */
export function loadMobileIdentity(home: string, origins: readonly string[], options: MaterialPolicy & { rotation?: "stage" | "promote"; now?: number } = {}): Promise<MobileTlsIdentity> {
  const dir = join(home, "mobile-identity");
  if (inFlight.has(dir)) return Promise.reject(new MobileActivationFault("material_unavailable"));
  const work = (async () => {
    try {
      await ensureDirectory(dir, options);
      for (const child of ["keys", "states", "archive"]) await ensureDirectory(join(dir, child), options);
      let { state, revision } = await readState(dir, options);
      if (!state) {
        // An interrupted first creation leaves evidence. Never replace or discard that key.
        if ((await fs.readdir(join(dir, "keys"))).length || options.rotation) throw new Error();
        state = { current: await newKey(dir, options) }; await writeState(dir, ++revision, state, options);
      }
      const current = await keyBytes(dir, state.current, options);
      if (options.rotation === "stage" && !state.next) { state = { ...state, next: await newKey(dir, options) }; await writeState(dir, ++revision, state, options); }
      if (options.rotation === "promote") {
        if (!state.next) throw new Error();
        await keyBytes(dir, state.next, options);
        const archived = join(dir, "archive", state.current + ".pem");
        try { await writeNew(archived, current, options); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readPrivateMaterial(archived, options)).equals(current)) throw error; }
        state = { current: state.next }; await writeState(dir, ++revision, state, options);
      }
      const key = await keyBytes(dir, state.current, options), pins = [spkiPin(key)];
      if (state.next) pins.push(spkiPin(await keyBytes(dir, state.next, options)));
      return { key, cert: await certificate(key, origins, options.now ?? Date.now()), pins };
    } catch { throw new MobileActivationFault("material_unavailable"); }
  })().finally(() => { inFlight.delete(dir); });
  inFlight.set(dir, work); return work;
}
