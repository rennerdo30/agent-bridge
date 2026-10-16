import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ResourceSlots
} from "./chunk-OBLECDCO.mjs";

// src/core/startup-admission.ts
import { randomUUID } from "node:crypto";
var STARTUP_CAPACITY = 2;
var STARTUP_RESOURCE = "delegate-startup";
var STARTUP_ROW_SEPARATOR = "~startup-";
async function acquireStartup(home, signal, job) {
  const slots = new ResourceSlots(home);
  const owner = { id: job ? `${job}${STARTUP_ROW_SEPARATOR}${randomUUID()}` : `startup-${randomUUID()}`, pid: process.pid };
  try {
    await slots.acquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner, signal);
  } catch (err) {
    slots.close();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      slots.release(owner, STARTUP_RESOURCE);
    } finally {
      slots.close();
    }
  };
}

export {
  STARTUP_CAPACITY,
  STARTUP_RESOURCE,
  STARTUP_ROW_SEPARATOR,
  acquireStartup
};
