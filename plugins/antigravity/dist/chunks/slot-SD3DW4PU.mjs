import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ResourceSlots,
  slotOwner
} from "./chunk-EL2JUENV.mjs";
import {
  RESOURCE_NAME_PATTERN
} from "./chunk-PC26HO4O.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-7NH7XSAT.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-5US2OQUB.mjs";
import "./chunk-NU7S2DHP.mjs";
import "./chunk-G5PLFO4A.mjs";
import "./chunk-4O6KB7UQ.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/slot.ts
var USAGE = "Usage: agent-bridge slot acquire|release|renew <resource> | slot status";
async function runSlot(argv, home, cfg, out) {
  const [action, resource] = argv;
  if (action !== "status" && (!["acquire", "release", "renew"].includes(action ?? "") || !resource || !RESOURCE_NAME_PATTERN.test(resource) || action === "acquire" && !Object.hasOwn(cfg.resourceSlots, resource))) {
    out(`${USAGE}
Resource must be configured in resourceSlots.`);
    return 2;
  }
  const slots = new ResourceSlots(home);
  const owner = slotOwner();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (action === "status") out(JSON.stringify({ capacities: cfg.resourceSlots, entries: slots.list() }, null, 2));
    else if (action === "acquire") {
      out(`Waiting for resource ${resource} (${cfg.resourceSlots[resource]} slots).`);
      await slots.acquire(resource, cfg.resourceSlots[resource], owner, controller.signal);
      out(`Acquired ${resource} for ${owner.id}.`);
    } else if (action === "release") {
      slots.release(owner, resource);
      out(`Released ${resource} for ${owner.id}.`);
    } else {
      slots.renew(owner, resource);
      out(`Renewed ${resource} for ${owner.id}.`);
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    slots.close();
  }
}
export {
  runSlot
};
