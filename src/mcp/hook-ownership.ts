import type { ServerContext } from "./server.js";
import type { HookInput } from "./hooks.js";

interface Ownership {
  epoch: number;
  prompt: string | null;
  closed: Set<string>;
  modSequence: number;
  modTurn?: string;
  modPrompt?: string | null;
}
const owners = new WeakMap<ServerContext, Ownership>();
function owner(ctx: ServerContext): Ownership {
  let state = owners.get(ctx);
  if (!state) { state = { epoch: 0, prompt: null, closed: new Set(), modSequence: -1 }; owners.set(ctx, state); }
  return state;
}
const promptKey = (input: HookInput) => input.promptId ? JSON.stringify([input.sessionId, input.promptId]) : null;

/** Reserve before asynchronous metadata work. Explicit old prompt ids cannot start a new epoch. */
export function reserveHook(ctx: ServerContext, input: HookInput): (() => boolean) | null {
  const state = owner(ctx), key = promptKey(input), node = ctx.node;
  if (key && (state.closed.has(key) || input.event !== "UserPromptSubmit" && state.prompt && state.prompt !== key)) return null;
  if (input.event === "UserPromptSubmit" && key) {
    if (state.modTurn && state.modPrompt && state.modPrompt !== key) state.modTurn = undefined;
    state.prompt = key;
    if (state.modTurn && !state.modPrompt) state.modPrompt = key;
  }
  const epoch = ++state.epoch;
  return () => ctx.node === node && !ctx.headless && state.epoch === epoch;
}

export function finishHookTurn(ctx: ServerContext, input?: HookInput): void {
  const state = owner(ctx), key = input ? promptKey(input) ?? state.prompt : state.prompt;
  if (key) {
    state.closed.add(key);
    if (state.closed.size > 128) state.closed.delete(state.closed.values().next().value!);
  }
  ctx.wakeDelivery?.idle?.();
  ctx.activity?.("idle");
}

export interface ModActivity { sessionId: string; turnId: string; sequence: number; busy: boolean }
/** Authenticated main-loop lifecycle, separate from synthetic delivery-confirmation toggles. */
export function reportModActivity(ctx: ServerContext, event: ModActivity): boolean {
  if (!ctx.node || ctx.headless || ctx.node.currentSessionId !== event.sessionId) return false;
  const state = owner(ctx);
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.modSequence || !event.turnId) return false;
  if (!event.busy && (state.modTurn !== event.turnId || state.modPrompt && state.modPrompt !== state.prompt)) return false;
  state.modSequence = event.sequence;
  if (event.busy) {
    state.modTurn = event.turnId;
    state.modPrompt = state.prompt;
    ++state.epoch;
    ctx.wakeDelivery?.confirm();
    ctx.wakeDelivery?.active();
    ctx.activity?.("busy");
  } else {
    state.modTurn = undefined;
    ++state.epoch;
    finishHookTurn(ctx);
  }
  return true;
}
