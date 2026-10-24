import { execFileSync, execFile } from "node:child_process";
import type { StartupBudget } from "../core/startup-budget.js";
type NetworkStartup = Pick<StartupBudget,"signal"|"remaining">;
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_NETWORK_HOST_CHARS, MAX_NETWORK_LINKS, MAX_PAIRING_CODE_CHARS, MAX_PORT, NETWORK_NAME_PATTERN, NETWORK_VERSION, OWNER_DIR_MODE, OWNER_FILE_MODE, PAIRING_KEY_BYTES, PAIRING_TTL_MS } from "./constants.js";

/** Windows' own tools by full path: a Unix toolchain on PATH (Git Bash, MSYS) brings same-named commands. */
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const SYSTEM32 = join(process.env.SystemRoot || DEFAULT_SYSTEM_ROOT, "System32");
const WHOAMI = join(SYSTEM32, "whoami.exe");
const ICACLS = join(SYSTEM32, "icacls.exe");

const keySchema = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z.object({ id: z.uuid(), key: keySchema });
export const publicIdentitySchema = z.object({ id: z.uuid(), name: z.string().regex(NETWORK_NAME_PATTERN), fingerprint: keySchema });
export type NetworkIdentity = z.infer<typeof publicIdentitySchema>;
const invitationSchema = z.object({ key: keySchema, expiresAt: z.number().int() });
const pairSchema = publicIdentitySchema.extend({ key: keySchema, host: z.string().min(1).max(MAX_NETWORK_HOST_CHARS).optional(), port: z.number().int().min(1).max(MAX_PORT).optional() });
export type NetworkPair = z.infer<typeof pairSchema>;
const stateSchema = z.object({ identity: identitySchema, invitations: z.array(invitationSchema).max(MAX_NETWORK_LINKS), pairs: z.array(pairSchema).max(MAX_NETWORK_LINKS) });
const codeSchema = publicIdentitySchema.extend({ v: z.literal(NETWORK_VERSION), key: keySchema });
export type PairingCode = z.infer<typeof codeSchema>;

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(Buffer.from(key, "hex")).digest("hex");
}

/** An `icacls <path>` line: "<path> DOMAIN\\name:(flags)" or "    DOMAIN\\name:(flags)". */
const ACL_PRINCIPAL = /([^\s:][^:]*?):\(/;

/**
 * Windows modes do not restrict ACLs: remove inherited grants, grant the current SID, and remove every other
 * explicit grant the folder already had (CI runners' temp folders carry some).
 */
export function protect(path: string, mode: number, ownNewPath = false): void {
  if (process.platform !== "win32") return chmodSync(path, mode);
  const [account, sid] = (execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/"([^"]+)","(S-\d+(?:-\d+)+)"/) ?? []).slice(1);
  if (!sid || !account) throw new Error("cannot identify the account for network key permissions");
  const grant = mode === OWNER_DIR_MODE ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  execFileSync(ICACLS, [path, "/inheritance:r", "/grant:r", grant, "/Q"], { windowsHide: true, stdio: "pipe" });
  // Windows Server can give newly created administrator objects a group owner.
  // Only exclusive creators opt in; existing material must never be repaired.
  if (ownNewPath) execFileSync(ICACLS, [path, "/setowner", `*${sid}`, "/Q"], { windowsHide: true, stdio: "pipe" });
  const others = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((line) => (line.startsWith(path) ? line.slice(path.length) : line).trim())
    .map((line) => ACL_PRINCIPAL.exec(line)?.[1])
    .filter((p): p is string => Boolean(p) && p!.toLowerCase() !== account.toLowerCase());
  for (const principal of new Set(others)) execFileSync(ICACLS, [path, "/remove:g", principal, "/Q"], { windowsHide: true, stdio: "pipe" });
  const acl = execFileSync(ICACLS, [path], { encoding: "utf8", windowsHide: true });
  if ((acl.match(/:\(/g) ?? []).length !== 1 || acl.includes("(I)")) throw new Error("network key location has additional ACL grants; restrict it to the current account");
}

/** Same ACL commands as protect; only startup uses cancellable owned children. */
async function protectStartup(path:string,mode:number,startup:NetworkStartup):Promise<void> {
  startup.remaining();if(process.platform!=='win32'){chmodSync(path,mode);startup.remaining();return;}
  const command=(file:string,args:string[])=>new Promise<string>((resolve,reject)=>{
    startup.remaining();let returned=false,closed=false,error:unknown,output='';
    const settle=()=>{if(!returned||!closed)return;try{startup.remaining();if(error)throw error;resolve(output);}catch{reject(new Error('Network key protection unavailable'));}};
    const child=execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:Math.max(1,Math.floor(startup.remaining())),signal:startup.signal},(failure,stdout)=>{returned=true;error=failure;output=stdout;settle();});
    const ownedPid=child.pid;child.once('close',()=>{closed=true;if(child.pid!==ownedPid)error=new Error('Owned ACL helper settlement unknown');settle();});
  });
  const [account,sid]=((await command(WHOAMI,['/user','/fo','csv','/nh'])).match(/"([^"]+)","(S-\d+(?:-\d+)+)"/)??[]).slice(1);
  startup.remaining();if(!sid||!account)throw new Error('cannot identify the account for network key permissions');
  const grant=mode===OWNER_DIR_MODE?`*${sid}:(OI)(CI)F`:`*${sid}:F`;
  await command(ICACLS,[path,'/inheritance:r','/grant:r',grant,'/Q']);startup.remaining();
  const others=(await command(ICACLS,[path])).split(/\r?\n/).map(line=>(line.startsWith(path)?line.slice(path.length):line).trim()).map(line=>ACL_PRINCIPAL.exec(line)?.[1]).filter((principal):principal is string=>Boolean(principal)&&principal!.toLowerCase()!==account.toLowerCase());
  for(const principal of new Set(others))await command(ICACLS,[path,'/remove:g',principal,'/Q']);
  const acl=await command(ICACLS,[path]);startup.remaining();
  if((acl.match(/:\(/g)??[]).length!==1||acl.includes('(I)'))throw new Error('network key location has additional ACL grants; restrict it to the current account');
}

export function decodePairingCode(code: string): PairingCode {
  if (code.length > MAX_PAIRING_CODE_CHARS || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("invalid pairing code");
  return codeSchema.parse(JSON.parse(Buffer.from(code, "base64url").toString("utf8")));
}

/** Only the elected broker writes this store. Secrets never go into the ordinary config or logs. */
export class PairingStore {
  private readonly dir: string;
  private readonly file: string;
  private state!: z.infer<typeof stateSchema>;
  private prepared=false;
  get isPrepared():boolean{return this.prepared;}

  constructor(home: string, readonly name: string, private readonly now: () => number = Date.now, startup?:NetworkStartup) {
    if (!NETWORK_NAME_PATTERN.test(name)) throw new Error("invalid network instance name");
    this.dir = join(home, "network");
    this.file = join(this.dir, "keys.json");
    if(startup){startup.remaining();return;}
    mkdirSync(this.dir, { recursive: true, mode: OWNER_DIR_MODE });
    protect(this.dir, OWNER_DIR_MODE);
    if (existsSync(this.file)) {
      protect(this.file, OWNER_FILE_MODE);
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } else {
      this.state = { identity: { id: randomUUID(), key: randomBytes(PAIRING_KEY_BYTES).toString("hex") }, invitations: [], pairs: [] };
      this.save();
    }
    this.prepared=true;
  }

  async prepare(startup:NetworkStartup):Promise<void> {
    startup.remaining();if(this.prepared)return;
    mkdirSync(this.dir,{recursive:true,mode:OWNER_DIR_MODE});startup.remaining();await protectStartup(this.dir,OWNER_DIR_MODE,startup);startup.remaining();
    if(existsSync(this.file)){
      await protectStartup(this.file,OWNER_FILE_MODE,startup);startup.remaining();this.state=stateSchema.parse(JSON.parse(readFileSync(this.file,'utf8')));startup.remaining();
    }else{
      this.state={identity:{id:randomUUID(),key:randomBytes(PAIRING_KEY_BYTES).toString('hex')},invitations:[],pairs:[]};
      const temp=join(this.dir,`${randomUUID()}.tmp`);startup.remaining();writeFileSync(temp,JSON.stringify(this.state,null,2)+'\n',{mode:OWNER_FILE_MODE,flag:'wx'});
      startup.remaining();await protectStartup(temp,OWNER_FILE_MODE,startup);startup.remaining();renameSync(temp,this.file);startup.remaining();
    }
    this.prepared=true;
  }

  get identity(): NetworkIdentity {
    return { id: this.state.identity.id, name: this.name, fingerprint: keyFingerprint(this.state.identity.key) };
  }

  pairs(): NetworkPair[] {
    return this.state.pairs.map((p) => ({ ...p }));
  }

  invite(): string { return this.inviteWithExpiry().code; }

  inviteWithExpiry(): { code: string; expiresAt: number } {
    this.state.invitations = this.state.invitations.filter((p) => p.expiresAt > this.now());
    if (this.state.invitations.length + this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    const key = randomBytes(PAIRING_KEY_BYTES).toString("hex");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.state.invitations.push({ key, expiresAt });
    this.save();
    return { code: Buffer.from(JSON.stringify({ v: NETWORK_VERSION, ...this.identity, key })).toString("base64url"), expiresAt };
  }

  keyFor(identity: string): string | undefined {
    return this.state.pairs.find((p) => keyFingerprint(p.key) === identity)?.key
      ?? this.state.invitations.find((p) => p.expiresAt > this.now() && keyFingerprint(p.key) === identity)?.key;
  }

  accept(key: string, remote: NetworkIdentity): NetworkPair {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("network instance ids and names must differ");
    const known = this.state.pairs.find((p) => p.key === key);
    if (known) {
      if (known.id !== remote.id || known.name !== remote.name || known.fingerprint !== remote.fingerprint) throw new Error("paired identity changed");
      return known;
    }
    const invitation = this.state.invitations.find((p) => p.key === key && p.expiresAt > this.now());
    if (!invitation) throw new Error("pairing code expired or revoked");
    this.checkNew(remote);
    const pair = { ...remote, key };
    this.state.pairs.push(pair);
    this.state.invitations = this.state.invitations.filter((p) => p !== invitation);
    this.save();
    return pair;
  }

  remember(code: PairingCode, host: string, port: number): NetworkPair {
    const parsed = this.validatePair(code, host, port);
    this.state.pairs = this.state.pairs.filter((p) => p.id !== parsed.id);
    this.state.pairs.push(parsed);
    this.save();
    return parsed;
  }

  validatePair(code: PairingCode, host: string, port: number): NetworkPair {
    const parsed = pairSchema.parse({ id: code.id, name: code.name, fingerprint: code.fingerprint, key: code.key, host, port });
    const old = this.state.pairs.find((p) => p.id === code.id);
    if (old && (old.key !== code.key || old.fingerprint !== code.fingerprint || old.name !== code.name)) throw new Error("unlink the existing peer before pairing again");
    if (!old) this.checkNew(parsed);
    return parsed;
  }

  private checkNew(remote: NetworkIdentity): void {
    if (remote.id === this.identity.id || remote.name === this.name) throw new Error("cannot pair with this instance");
    if (this.state.pairs.length >= MAX_NETWORK_LINKS) throw new Error("network pairing limit reached");
    if (this.state.pairs.some((p) => p.id === remote.id || p.name === remote.name)) throw new Error("instance already paired; unlink it first");
  }

  remove(id: string): void {
    this.state.pairs = this.state.pairs.filter((p) => p.id !== id);
    this.save();
  }

  private save(): void {
    const temp = join(this.dir, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n", { mode: OWNER_FILE_MODE, flag: "wx" });
    protect(temp, OWNER_FILE_MODE);
    renameSync(temp, this.file);
  }
}
