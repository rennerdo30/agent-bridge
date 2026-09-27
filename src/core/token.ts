import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_FILE_NAME = "token";
const TOKEN_BYTES = 32;
const OWNER_ONLY = 0o600;

export function tokenPath(home: string): string {
  return join(home, TOKEN_FILE_NAME);
}

/**
 * Shared secret that every agent-bridge process of this user presents to the broker. Created on first
 * use with owner-only permissions; concurrent first starts agree on one file via exclusive create.
 */
export function loadOrCreateToken(home: string): string {
  const file = tokenPath(home);
  mkdirSync(dirname(file), { recursive: true });
  try {
    const fd = openSync(file, "wx", OWNER_ONLY);
    try {
      writeSync(fd, randomBytes(TOKEN_BYTES).toString("hex"));
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(file, OWNER_ONLY);
    } catch {
      // Windows ignores POSIX modes; the file lives in the user's profile.
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`agent-bridge token file is empty: ${file}`);
  return token;
}

/** Constant-time comparison so the broker leaks nothing about the token through timing. */
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
