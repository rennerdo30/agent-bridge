import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/token.ts
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
var TOKEN_FILE_NAME = "token";
var TOKEN_BYTES = 32;
var OWNER_ONLY = 384;
var EMPTY_TOKEN_WAIT_MS = 2e3;
function tokenPath(home) {
  return join(home, TOKEN_FILE_NAME);
}
function loadOrCreateToken(home) {
  const file = tokenPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 448 });
  if (!existsSync(file)) {
    const temp = join(dirname(file), `.token-${randomUUID()}`);
    let created = false;
    try {
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const fd = openSync(temp, "wx", OWNER_ONLY);
      created = true;
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(temp, OWNER_ONLY);
      } catch {
      }
      try {
        linkSync(temp, file);
      } catch (err) {
        if (err.code !== "EEXIST") {
          try {
            writeFileSync(file, token, { flag: "wx", mode: OWNER_ONLY });
          } catch (inner) {
            if (inner.code !== "EEXIST") throw inner;
          }
        }
      }
    } finally {
      if (created) try {
        unlinkSync(temp);
      } catch {
      }
    }
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + EMPTY_TOKEN_WAIT_MS; ; ) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
    if (Date.now() >= deadline) throw new Error(`agent-bridge token file is empty: ${file}`);
    Atomics.wait(pause, 0, 0, 25);
  }
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
