import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/token.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
var TOKEN_FILE_NAME = "token";
var TOKEN_BYTES = 32;
var OWNER_ONLY = 384;
function tokenPath(home) {
  return join(home, TOKEN_FILE_NAME);
}
function loadOrCreateToken(home) {
  const file = tokenPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 448 });
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
    }
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`agent-bridge token file is empty: ${file}`);
  return token;
}
function tokensEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export {
  loadOrCreateToken,
  tokensEqual
};
