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
  codex: /\busage limit(?: has been| is)? (?:reached|exceeded|exhausted)\b|\byou(?:'|’)ve hit your usage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
  claude: /\busage limit(?: has been| is)? (?:reached|exceeded|exhausted)\b|\byou(?:'|’)ve hit your (?:usage )?limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
  opencode: /\busage limit(?: has been| is)? (?:reached|exceeded|exhausted)\b|\byou(?:'|’)ve hit your usage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
  antigravity: /\busage limit(?: has been| is)? (?:reached|exceeded|exhausted)\b|\byou(?:'|’)ve hit your usage limit\b|\b(?:weekly|plan) (?:usage )?limit (?:reached|exceeded)\b/i,
};
const CREDIT_MESSAGE = /\bno credits(?: available| remaining| left)?(?:[.!,:;]|$)|\b(?:insufficient credits|insufficient balance|credit balance is too low|balance too low)\b/i;
const BILLING_MESSAGE = /\bbilling(?: is)? required\b|\bpayment(?: is)? required\b/i;
const RATE_LIMIT_MESSAGE = /\brate[ _-]?limit (?:exceeded|reached)\b|\brate[ _-]?limited\b|\brate_limit_error\b|\btoo many requests\b/i;
// These are observations/questions/denials, not positive failure facts. Fail closed on ambiguity.
const NON_ASSERTION = /\b(?:not|never|false|unknown|unclear|unconfirmed|maybe|possibly|might|whether|if|could|example|quoted)\b|\bno (?:evidence|indication|usage limit|weekly limit|plan limit|rate limit|overload)\b|\?/i;
// Uncertainty about attribution/reset/instructions does not deny an exhaustion predicate.
const DETAIL_QUALIFIER = /^(?:the )?(?:reset(?: time| date)?|model(?: attribution)?|details|billing instructions|payment instructions)\b/i;
const EXHAUSTION_TOPIC = /\b(?:quota|credits?|balance|usage|limit|reached|exceeded|exhausted|required)\b|\btoo low\b/i;
// Vague quota/credit/billing reports never establish transient capacity, even alongside overload.
const AMBIGUOUS_QUOTA_MESSAGE = /\b(?:quota|credits?|balance|billing)\b|\b(?:usage|weekly|plan) limit\b/i;

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
  // Separate independent sentences/fragments before checking each exhaustion subject.
  const assertions = messages.flatMap(message => message.split(/[.;]\s+|\r?\n/));
  const asserts = (pattern: RegExp) => assertions.some(message => pattern.test(message) && !NON_ASSERTION.test(message));
  const assertsTerminal = (pattern: RegExp, subject: RegExp) => {
    const detailOnly = (clause: string) => DETAIL_QUALIFIER.test(clause) && !EXHAUSTION_TOPIC.test(clause);
    // A separate denial of the same exhaustion subject is a contradiction, not metadata.
    if (assertions.some(message => message.split(/,\s*/).some(clause => subject.test(clause)
      && NON_ASSERTION.test(clause) && !detailOnly(clause)))) return false;
    return assertions.some(message => {
      const clauses = message.split(/,\s*/);
      const positive = clauses.some(clause => pattern.test(clause) && !NON_ASSERTION.test(clause));
      // An explicit denial/uncertain quota clause vetoes this statement, including anaphoric
      // "actually false/not reached". Only narrowly named non-quota details may stay unknown.
      return positive && clauses.every(clause => !NON_ASSERTION.test(clause) || detailOnly(clause));
    });
  };
  const hasCode = (...expected: string[]) => codes.some(code => expected.includes(code));
  const retryAfterMs = reportedTime(input.reportedRetryAfterMs, true);
  const resetAt = reportedTime(input.reportedResetAt, false);
  let kind: ProviderFailureKind = "unknown";

  // Scan ALL evidence before bounding the stored message. Any terminal fact beats capacity.
  // Stable tie break for multiple terminal facts: billing, credits, usage.
  if (hasCode("billing_required", "payment_required") || assertsTerminal(BILLING_MESSAGE, /\b(?:billing|payment)\b/i)) kind = "billing_required";
  else if (hasCode("no_credits", "insufficient_credits", "insufficient_balance") || assertsTerminal(CREDIT_MESSAGE, /\b(?:credits?|balance)\b/i)) kind = "no_credits";
  else if (hasCode("usage_limit", "usage_limit_reached", "insufficient_quota") || assertsTerminal(USAGE_MESSAGES[input.agent], /\b(?:usage|weekly|plan) limit\b|\bquota\b/i)) kind = "usage_limit";
  else if (!matches(AMBIGUOUS_QUOTA_MESSAGE) && !messages.some(message => NON_ASSERTION.test(message))) {
    const rateLimited = asserts(RATE_LIMIT_MESSAGE) || hasCode("rate_limit_error", "rate_limit_exceeded");
    // A rate-limit report needs an explicit short delay. A bare status429 is insufficient.
    if (rateLimited) {
      if (retryAfterMs !== undefined && retryAfterMs <= PROVIDER_SHORT_RETRY_AFTER_MAX_MS) kind = "capacity";
    } else if (asserts(CAPACITY_MESSAGES[input.agent]) || codes.some(code => CAPACITY_CODES[input.agent].includes(code))) kind = "capacity";
  }

  return {
    agent: input.agent, model: input.model, kind, retryable: kind === "capacity",
    message: boundedMessage(messages.filter(Boolean).join("\n")),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}
