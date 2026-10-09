import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_FILE_NAME = "token";
const TOKEN_BYTES = 32;
const OWNER_ONLY = 0o600;
const EMPTY_TOKEN_WAIT_MS = 2_000;

export function tokenPath(home: string): string {
  return join(home, TOKEN_FILE_NAME);
}

/**
 * Shared secret that every agent-bridge process of this user presents to the broker. Created on first
 * use with owner-only permissions; concurrent first starts agree on one file via exclusive create.
 */
export function loadOrCreateToken(home: string): string {
  const file = tokenPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); // owner-only on Unix
  if (!existsSync(file)) {
    // Write a private temp file completely, then publish it with an exclusive hard link: a concurrent first
    // start never sees a created but still empty token file (AB-244). The loser keeps the winner's token.
    const temp = join(dirname(file), `.token-${randomUUID()}`);
    let created = false;
    try {
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const fd = openSync(temp, "wx", OWNER_ONLY);
      created = true;
      try { writeSync(fd, token); } finally { closeSync(fd); }
      try { chmodSync(temp, OWNER_ONLY); } catch { /* Windows ignores POSIX modes; the file lives in the user's profile. */ }
      try { linkSync(temp, file); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          // No hard links on this filesystem: exclusive create, as before; readers below wait out the gap.
          try { writeFileSync(file, token, { flag: "wx", mode: OWNER_ONLY }); }
          catch (inner) { if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner; }
        }
      }
    } finally { if (created) try { unlinkSync(temp); } catch { /* Our own unpublished temp file. */ } }
  }
  // An older release creates the file before writing it: give such a concurrent first start a moment.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + EMPTY_TOKEN_WAIT_MS; ;) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
    if (Date.now() >= deadline) throw new Error(`agent-bridge token file is empty: ${file}`);
    Atomics.wait(pause, 0, 0, 25);
  }
}

/** Constant-time comparison so the broker leaks nothing about the token through timing. */
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
