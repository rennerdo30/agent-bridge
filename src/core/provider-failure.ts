/** Pure AB326 classification only. No retry, quota cache, provider calls or network policy. */
export type ProviderFailureAgent = "codex" | "claude" | "opencode" | "antigravity";
export type ProviderFailureKind = "capacity" | "usage_limit" | "no_credits" | "billing_required" | "unknown";

export const PROVIDER_FAILURE_MESSAGE_MAX_CHARS = 2_000;
export const PROVIDER_SHORT_RETRY_AFTER_MAX_MS = 60_000;

export interface ProviderFailureInput {
  agent: ProviderFailureAgent;
  /** The effective model reported by the adapter, never a guessed default. */
  model: string | null;
  message: string;
  /** Error-only evidence from the same attempt; do not pass task text or historic errors. */
  additionalMessages?: readonly string[];
  codes?: readonly string[];
  /** Already decoded actual provider facts. Never derive these from a backoff or config. */
  reportedRetryAfterMs?: number;
  reportedResetAt?: number;
}

export interface ProviderFailure {
  agent: ProviderFailureAgent;
  model: string | null;
  kind: ProviderFailureKind;
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
  resetAt?: number;
}

// CLI-specific positive evidence, deliberately excluding generic 5xx/network/database errors.
const CAPACITY_MESSAGES: Record<ProviderFailureAgent, RegExp> = {
  codex: /\b(?:selected )?model is at capacity\b/i,
  claude: /\b(?:overloaded(?:_error)?|model is at capacity)\b/i,
  opencode: /\b(?:overloaded(?:_error)?|model is at capacity)\b/i,
  antigravity: /\b(?:model is at capacity|model capacity exhausted|model is overloaded)\b/i,
};
const CAPACITY_CODES: Record<ProviderFailureAgent, readonly string[]> = {
  codex: ["model_at_capacity"],
  claude: ["overloaded_error"],
  opencode: ["overloaded_error"],
  antigravity: ["model_at_capacity"],
};
const USAGE_MESSAGES: Record<ProviderFailureAgent, RegExp> = {
  codex: /\busage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
  claude: /\busage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b|\byou(?:'|’)ve hit your limit\b/i,
  opencode: /\busage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
  antigravity: /\busage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
};
const CREDIT_MESSAGE = /\b(?:no credits|insufficient credits|insufficient balance|credit balance is too low|balance too low)\b/i;
const BILLING_MESSAGE = /\bbilling(?: is)? required\b|\bpayment(?: is)? required\b/i;
const RATE_LIMIT_MESSAGE = /\brate[ _-]?limit(?:ed|_error)?\b|\btoo many requests\b/i;
// Vague quota/credit/billing reports never establish transient capacity, even alongside overload.
const AMBIGUOUS_QUOTA_MESSAGE = /\b(?:quota|credits?|balance|billing)\b/i;

function reportedTime(value: number | undefined, positive: boolean): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0) ? value : undefined;
}

function boundedMessage(message: string): string {
  if (message.length <= PROVIDER_FAILURE_MESSAGE_MAX_CHARS) return message;
  // Retain the error tail as well: terminal evidence can follow a long overload detail.
  const head = Math.floor(PROVIDER_FAILURE_MESSAGE_MAX_CHARS / 2);
  return message.slice(0, head) + "\n…\n" + message.slice(-(PROVIDER_FAILURE_MESSAGE_MAX_CHARS - head - 3));
}

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  const messages = [input.message, ...(input.additionalMessages ?? [])];
  const codes = (input.codes ?? []).map(code => code.trim().toLowerCase());
  const matches = (pattern: RegExp) => messages.some(message => pattern.test(message));
  const hasCode = (...expected: string[]) => codes.some(code => expected.includes(code));
  const retryAfterMs = reportedTime(input.reportedRetryAfterMs, true);
  const resetAt = reportedTime(input.reportedResetAt, false);
  let kind: ProviderFailureKind = "unknown";

  // Scan ALL evidence before bounding the stored message. Any terminal fact beats capacity.
  // Stable tie break for multiple terminal facts: billing, credits, usage.
  if (hasCode("billing_required", "payment_required") || matches(BILLING_MESSAGE)) kind = "billing_required";
  else if (hasCode("no_credits", "insufficient_credits", "insufficient_balance") || matches(CREDIT_MESSAGE)) kind = "no_credits";
  else if (hasCode("usage_limit", "usage_limit_reached", "insufficient_quota") || matches(USAGE_MESSAGES[input.agent])) kind = "usage_limit";
  else if (!matches(AMBIGUOUS_QUOTA_MESSAGE)) {
    const rateLimited = matches(RATE_LIMIT_MESSAGE) || hasCode("rate_limit_error", "rate_limit_exceeded");
    // A rate-limit report needs an explicit short delay. A bare status429 is insufficient.
    if (rateLimited) {
      if (retryAfterMs !== undefined && retryAfterMs <= PROVIDER_SHORT_RETRY_AFTER_MAX_MS) kind = "capacity";
    } else if (matches(CAPACITY_MESSAGES[input.agent]) || codes.some(code => CAPACITY_CODES[input.agent].includes(code))) kind = "capacity";
  }

  return {
    agent: input.agent, model: input.model, kind, retryable: kind === "capacity",
    message: boundedMessage(messages.filter(Boolean).join("\n")),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}
