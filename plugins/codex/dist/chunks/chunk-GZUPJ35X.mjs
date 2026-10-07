import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  AGENT_KINDS
} from "./chunk-SOPZATYP.mjs";

// src/core/job-messaging.ts
var DEFAULT_SIBLING_MAX_HOPS = 32;
var MAX_JOB_SEND_TARGETS = 20;
function isPureAcknowledgement(body) {
  const text = body.trim();
  return /^(?:ack(?:nowledged)?|received|thanks|thank you|understood|got it|noted|ok(?:ay)?|will do)[.!]?$/i.test(text) || /^(?:understood|got it|noted|acknowledged)[,.!]?\s+(?:I['’]ll|I will|will)\s+[^\n.!?]{1,180}[.!]?$/i.test(text) && !/\b(?:blocked|failed|error|cannot|can't|unless|but|commit|passed|ready)\b|https?:|\d/i.test(text);
}
var EXACT_PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isJobSendTarget(value) {
  return typeof value === "string" && EXACT_PEER_NAME_PATTERN.test(value) && !AGENT_KINDS.includes(value);
}
function siblingMaxHops(maxHops) {
  return maxHops > 0 ? Math.max(maxHops, DEFAULT_SIBLING_MAX_HOPS) : 0;
}

export {
  DEFAULT_SIBLING_MAX_HOPS,
  MAX_JOB_SEND_TARGETS,
  isPureAcknowledgement,
  isJobSendTarget,
  siblingMaxHops
};
