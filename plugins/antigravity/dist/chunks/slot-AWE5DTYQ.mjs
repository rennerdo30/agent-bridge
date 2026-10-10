import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ResourceSlots,
  slotOwner
} from "./chunk-NY45KO7G.mjs";
import {
  RESOURCE_NAME_PATTERN
} from "./chunk-5I7IJLKF.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-DAI2VPPJ.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-S4W4VZWF.mjs";
import "./chunk-5KYAJ3AQ.mjs";
import "./chunk-XTHHW5FU.mjs";
import "./chunk-HHAVWD7J.mjs";

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
