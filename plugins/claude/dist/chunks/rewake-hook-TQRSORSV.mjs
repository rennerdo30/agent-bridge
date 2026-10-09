import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  sessionFile
} from "./chunk-UPFHVILI.mjs";
import "./chunk-3EY3DDNH.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import {
  resolveHome
} from "./chunk-L4M5HEV4.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/rewake-hook.ts
import { readFileSync } from "node:fs";
var EXIT_WAKE = 2;
var MAX_WAIT_MS = 7e3 * 1e3;
async function readStdin() {
  return readBodyText(process.stdin);
}
async function runRewakeHook(standby = false) {
  let sessionId = "";
  try {
    sessionId = String(JSON.parse(await readStdin() || "{}").session_id ?? "");
  } catch {
    return 0;
  }
  if (!sessionId) return 0;
  let reg;
  try {
    reg = JSON.parse(readFileSync(sessionFile(resolveHome(), sessionId), "utf8"));
  } catch {
    return 0;
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${reg.port}/wait${standby ? "?role=standby" : ""}`, { headers: { authorization: `Bearer ${reg.secret}` } });
    } catch {
      return 0;
    }
    if (!res.ok) return 0;
    const { text, superseded } = await res.json();
    if (text) {
      process.stderr.write(text);
      return EXIT_WAKE;
    }
    if (superseded) return 0;
  }
  return 0;
}
export {
  runRewakeHook
};
