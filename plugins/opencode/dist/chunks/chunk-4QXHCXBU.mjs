import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/protocol.ts
var AGENT_KINDS = ["claude", "codex", "opencode", "antigravity", "other"];
var CODING_AGENTS = ["claude", "codex", "opencode", "antigravity"];
var BROADCAST = "*";
var SIBLING_CONVERSATION_PREFIX = "siblings-";
var SIBLING_NOTE_SUFFIX = ":note";
var ACK_CONVERSATION_SUFFIX = ":ack";
var TRANSFER_PROGRESS_PREFIX = "files-progress-";
var QUESTION_CONVERSATION_SUFFIX = ":question";
function isJobQuestion(m) {
  return /^job-[^:]+:question(?::fallback)?$/.test(m.conversationId);
}
function isQuietMessage(m) {
  return m.conversationId.endsWith(SIBLING_NOTE_SUFFIX) || m.conversationId.endsWith(ACK_CONVERSATION_SUFFIX) || m.conversationId.startsWith(TRANSFER_PROGRESS_PREFIX);
}
var BridgeError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "BridgeError";
  }
  code;
  details;
  toPayload() {
    return { code: this.code, message: this.message, ...this.details ? { details: this.details } : {} };
  }
};
var FrameDecoder = class {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  buffer = "";
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
      this.buffer = "";
      throw new BridgeError("too_large", "frame exceeds maximum size");
    }
    const frames = [];
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      frames.push(JSON.parse(line));
    }
    return frames;
  }
};
function encodeFrame(frame) {
  return JSON.stringify(frame) + "\n";
}
function isUnsupportedOperation(error, op) {
  return error instanceof Error && (error.message.includes(`unknown op: ${op}`) || error instanceof BridgeError && error.code === "protocol_mismatch" && (error.details?.operation === op || error.message.includes(`does not support ${op} required`)));
}

export {
  AGENT_KINDS,
  CODING_AGENTS,
  BROADCAST,
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  ACK_CONVERSATION_SUFFIX,
  TRANSFER_PROGRESS_PREFIX,
  QUESTION_CONVERSATION_SUFFIX,
  isJobQuestion,
  isQuietMessage,
  BridgeError,
  FrameDecoder,
  encodeFrame,
  isUnsupportedOperation
};
