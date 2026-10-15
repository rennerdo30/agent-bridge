import type { ServerContext } from "./server.js";
import type { HookInput } from "./hooks.js";

interface Ownership {
  epoch: number;
  prompt: string | null;
  closed: Set<string>;
  modSequence: number;
  modInstance: string;
  retiredMods: Set<string>;
  modCompleted: boolean;
  modTurn?: string;
  modPrompt?: string | null;
}
const owners = new WeakMap<ServerContext, Ownership>();
function owner(ctx: ServerContext): Ownership {
  let state = owners.get(ctx);
  if (!state) { state = { epoch: 0, prompt: null, closed: new Set(), modSequence: -1, modInstance: "", retiredMods: new Set(), modCompleted: false }; owners.set(ctx, state); }
  return state;
}
const promptKey = (input: HookInput) => input.promptId ? JSON.stringify([input.sessionId, input.promptId]) : null;

/** Reserve before asynchronous metadata work. Explicit old prompt ids cannot start a new epoch. */
export function reserveHook(ctx: ServerContext, input: HookInput): (() => boolean) | null {
  const state = owner(ctx), key = promptKey(input), node = ctx.node;
  if (state.modCompleted && input.event === "PostToolUse") return null;
  if (key && (state.closed.has(key) || input.event !== "UserPromptSubmit" && state.prompt && state.prompt !== key)) return null;
  if (input.event === "UserPromptSubmit" && key) {
    if (state.modTurn && state.modPrompt && state.modPrompt !== key) state.modTurn = undefined;
    state.prompt = key;
    if (state.modTurn && !state.modPrompt) state.modPrompt = key;
  }
  if (input.event === "UserPromptSubmit" || input.event === "SessionStart") state.modCompleted = false;
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

export interface ModActivity { sessionId: string; turnId: string; sequence: number; busy: boolean; instance?: string }
/** Authenticated main-loop lifecycle, separate from synthetic delivery-confirmation toggles. */
export function reportModActivity(ctx: ServerContext, event: ModActivity): boolean {
  if (!ctx.node || ctx.headless || ctx.node.currentSessionId !== event.sessionId) return false;
  const state = owner(ctx);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.turnId) return false;
  const instance = event.instance ?? "";
  if (instance.length > 128 || state.retiredMods.has(instance)) return false;
  if (instance !== state.modInstance) {
    if (!event.busy) return false;
    state.retiredMods.add(state.modInstance);
    state.modInstance = instance;
    state.modSequence = -1;
  }
  if (event.sequence <= state.modSequence) return false;
  if (!event.busy && (state.modTurn !== event.turnId || state.modPrompt && state.modPrompt !== state.prompt)) return false;
  state.modSequence = event.sequence;
  if (event.busy) {
    state.modCompleted = false;
    state.modTurn = event.turnId;
    state.modPrompt = state.prompt && !state.closed.has(state.prompt) ? state.prompt : null;
    ++state.epoch;
    ctx.wakeDelivery?.confirm();
    ctx.wakeDelivery?.active();
    ctx.activity?.("busy");
  } else {
    state.modCompleted = true;
    state.modTurn = undefined;
    ++state.epoch;
    finishHookTurn(ctx);
  }
  return true;
}
