/**
 * Pinned contract (issue #14): four escalate-only decision gates wrapping the
 * deterministic classifier from issue #13. `triageGate`, `patchReviewGate`,
 * `promotionGate`, and `iterationGate` each take a stage output plus any LLM
 * suggestion and return `{ decision, overruled, reason }` whose decision can
 * only be equal to or more conservative than the classifier tier: an LLM
 * suggestion to lower a tier is ignored and recorded as `overruled: true`.
 * Strictness order is `flag-only < auto-promote < approve < escalate` (the
 * iteration gate adds a `retry` floor at the `approve` rank plus the terminal
 * `give-up` verdict); promotion additionally withholds `auto-promote` unless
 * the classifier tier is `auto-promote`, verification has not failed, and
 * patch similarity meets `PROMOTION_SIMILARITY_THRESHOLD`. Iteration consults
 * an explicit attempt count when one is supplied and a module-level fallback
 * counter otherwise (reset via `resetIterationGate`), giving up on the
 * `MAX_ITERATION_ATTEMPTS`-th unsuccessful verification and capping further
 * invocations at `give-up`. Pure over untrusted data, tolerant of alias
 * shapes and positional `(output, suggestion)` calls; never throws and never
 * mutates its inputs — malformed input escalates on doubt.
 */

import {
  APPROVE_FLAGS,
  SAFE_FLAGS,
  TIER_CONFIDENCE_THRESHOLD,
  classifyTier,
} from "./tier.js";
import type { Tier } from "./tier.js";

/** Re-exported so gate consumers can name classifier tiers without importing `tier.ts`. */
export type { Tier };

/**
 * Final gate outcomes: the four classifier tiers plus the iteration loop's
 * `retry` (verification pending, promotion withheld) and terminal `give-up`
 * (iteration budget exhausted).
 */
export type GateDecision = Tier | "retry" | "give-up";

/** Gate verdict: the final decision, whether an LLM loosening was ignored, and why. */
export interface GateResult {
  decision: GateDecision;
  overruled: boolean;
  reason?: string;
}

/** Patch similarity at or above this keeps an `auto-promote` promotion alive. */
export const PROMOTION_SIMILARITY_THRESHOLD = 0.8;

/** Unsuccessful verifications before the iteration gate gives up. */
export const MAX_ITERATION_ATTEMPTS = 3;

/**
 * Strictness rank; a gate result honors escalate-only when its decision ranks
 * at or above the classifier tier. `retry` holds the `approve` rank:
 * withholding promotion is as cautious as requiring approval.
 */
export const TIER_RANK: Readonly<Record<GateDecision, number>> = {
  "flag-only": 0,
  "auto-promote": 1,
  approve: 2,
  retry: 2,
  escalate: 3,
  "give-up": 4,
};

/**
 * Stricter of the given decisions (first wins ties); unknown values count as
 * `escalate` so doubt can never pick the looser side.
 */
export function maxTier(...tiers: GateDecision[]): GateDecision {
  let best: GateDecision = "flag-only";
  for (const tier of tiers) {
    if (rankOf(tier) > rankOf(best)) best = tier;
  }
  return best;
}

function rankOf(tier: unknown): number {
  if (typeof tier === "string") {
    const rank = (TIER_RANK as Readonly<Record<string, number>>)[tier];
    if (typeof rank === "number") return rank;
  }
  return TIER_RANK.escalate;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Classifier-tier aliases read from the stage output (first defined wins). */
const BASE_TIER_KEYS: readonly string[] = [
  "classifierTier",
  "tier",
  "baseTier",
  "classifier_tier",
  "base_tier",
];

/** LLM-suggestion aliases read from the stage output or the trailing argument. */
const SUGGESTION_KEYS: readonly string[] = [
  "llmSuggestion",
  "suggestion",
  "llmVerdict",
  "verdict",
  "llm",
  "decision",
  "outcome",
  "recommendation",
  "action",
];

/** Tier-signal keys inside one suggestion object. */
const TIER_SIGNAL_KEYS: readonly string[] = [
  "tier",
  "riskTier",
  "risk",
  ...SUGGESTION_KEYS,
];

/** Patch-similarity aliases (promotion bar and instability signal). */
const SIMILARITY_KEYS: readonly string[] = [
  "similarity",
  "patchSimilarity",
  "similarityScore",
  "score",
  "patch_similarity",
];

/** Iteration-count aliases (1-indexed attempts; the fallback counter covers absence). */
const COUNT_KEYS: readonly string[] = [
  "attempt",
  "attempts",
  "iteration",
  "iterationCount",
  "count",
  "invocationCount",
  "invocations",
  "attemptNumber",
  "tryCount",
];

/** Verification-success aliases (only an explicit `true` counts as success). */
const SUCCESS_KEYS: readonly string[] = [
  "verified",
  "verificationPassed",
  "verification_passed",
  "success",
  "passed",
];

/** Verification-failure aliases that withhold an `auto-promote` promotion. */
const UNVERIFIED_KEYS: readonly string[] = [
  "verified",
  "verificationPassed",
  "verification_passed",
];

/** Boolean approval aliases inside a suggestion object. */
const GREEN_KEYS: readonly string[] = ["approve", "approved", "proceed", "accept"];
const RED_KEYS: readonly string[] = ["reject", "rejected", "deny", "denied", "escalate"];

function tokenize(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

const TOKEN_SAFE_FLAGS: ReadonlySet<string> = new Set(
  [...SAFE_FLAGS].map((flag) => tokenize(flag)),
);
const TOKEN_APPROVE_FLAGS: ReadonlySet<string> = new Set(
  [...APPROVE_FLAGS].map((flag) => tokenize(flag)),
);
const TOKEN_UNSTABLE_FLAGS: ReadonlySet<string> = new Set([
  "unstable",
  "needsmoreinfo",
  "needsinfo",
  "moreinfo",
  "requiresapproval",
  "needsapproval",
  "requireapproval",
]);

/** How an LLM `reject` verdict maps: straight to `escalate`, or one step up via `maxTier`. */
type RejectPolicy = "escalate" | "conditional";

/**
 * Map one normalized suggestion token to its implied tier. `REJECT` needs the
 * gate's reject policy plus the classifier tier, so it is resolved by the
 * caller. Blank tokens carry no signal; unknown tokens escalate on doubt.
 */
function impliedFromString(value: string): GateDecision | "REJECT" | null {
  const token = tokenize(value);
  if (token === "") return null;
  switch (token) {
    case "flagonly":
      return "flag-only";
    case "autopromote":
      return "auto-promote";
    case "approve":
    case "approved":
      return "approve";
    case "escalate":
    case "escalated":
    case "escalation":
      return "escalate";
    case "reject":
    case "rejected":
    case "rejection":
    case "deny":
    case "denied":
      return "REJECT";
    case "needsmoreinfo":
    case "needsinfo":
    case "moreinfo":
      return "approve";
    case "proceed":
    case "accept":
    case "accepted":
    case "pass":
    case "ok":
    case "continue":
    case "goahead":
      return "auto-promote";
    case "giveup":
    case "abort":
    case "abandon":
      return "escalate";
    case "retry":
    case "requeue":
    case "reverify":
      return "approve";
    case "needsapproval":
    case "requiresapproval":
    case "requireapproval":
      return "approve";
    case "unstable":
    case "uncertain":
    case "unsure":
    case "lowconfidence":
      return "approve";
    default:
      return "escalate";
  }
}

/** A rejection blocks promotion: `escalate` outright, or one step up from a calm base. */
function resolveReject(policy: RejectPolicy, base: Tier): GateDecision {
  if (policy === "escalate") return "escalate";
  return rankOf(base) >= rankOf("approve") ? "escalate" : "approve";
}

/** Stricter of two implied tiers, tolerating absent signals on either side. */
function maxImplied(
  current: GateDecision | null,
  next: GateDecision | null,
): GateDecision | null {
  if (next === null) return current;
  if (current === null) return next;
  return rankOf(next) > rankOf(current) ? next : current;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Flag lists mirror the classifier: safe adds nothing, approve needs a human, unknown doubts. */
function impliedFromFlags(flags: unknown): GateDecision | null {
  if (!Array.isArray(flags)) return "escalate";
  let best: GateDecision | null = null;
  let seen = false;
  for (const entry of flags) {
    seen = true;
    if (typeof entry !== "string") return "escalate";
    const token = tokenize(entry);
    if (TOKEN_SAFE_FLAGS.has(token)) continue;
    if (TOKEN_APPROVE_FLAGS.has(token) || TOKEN_UNSTABLE_FLAGS.has(token)) {
      best = maxImplied(best, "approve");
    } else {
      return "escalate";
    }
  }
  return seen ? best : null;
}

/** Confidence below the classifier threshold signals instability; invalid values doubt. */
function impliedFromConfidence(value: unknown): GateDecision | null {
  const parsed = coerceNumber(value);
  if (parsed === undefined) return "escalate";
  if (parsed >= TIER_CONFIDENCE_THRESHOLD && parsed <= 1) return null;
  if (parsed >= 0 && parsed < TIER_CONFIDENCE_THRESHOLD) return "approve";
  return "escalate";
}

/** Similarity below the promotion threshold signals instability; invalid values doubt. */
function impliedFromSimilarity(value: unknown): GateDecision | null {
  const parsed = coerceNumber(value);
  if (parsed === undefined) return "escalate";
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  if (normalized < 0 || normalized > 1) return "escalate";
  return normalized < PROMOTION_SIMILARITY_THRESHOLD ? "approve" : null;
}

/**
 * Strictest tier implied by one suggestion source, or `null` when it carries
 * no signal. Strings map verbatim; objects contribute their tier-signal,
 * flags, confidence, similarity, and approval keys; anything else present is
 * doubt. `implicit` marks the top-level stage output, where unrecognized keys
 * belong to the stage (not the LLM) and base-tier keys are not suggestions.
 */
function impliedFromValue(
  source: unknown,
  policy: RejectPolicy,
  base: Tier,
  depth: number,
  implicit: boolean,
): GateDecision | null {
  if (source === undefined || source === null) return null;
  if (typeof source === "string") {
    const mapped = impliedFromString(source);
    if (mapped === null || mapped === "REJECT") {
      return mapped === null ? null : resolveReject(policy, base);
    }
    return mapped;
  }
  if (typeof source === "number" || typeof source === "boolean") return "escalate";
  if (Array.isArray(source)) {
    let best: GateDecision | null = null;
    for (const entry of source) {
      best = maxImplied(best, impliedFromValue(entry, policy, base, depth, false));
    }
    return best;
  }
  if (isPlainObject(source)) {
    if (depth > 5) return "escalate";
    let best: GateDecision | null = null;
    let recognized = false;
    for (const key of TIER_SIGNAL_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      if (implicit && (BASE_TIER_KEYS as readonly string[]).includes(key)) continue;
      const value = source[key];
      if (value === undefined || value === null) continue;
      recognized = true;
      best = maxImplied(best, impliedFromValue(value, policy, base, depth + 1, false));
    }
    if (Object.hasOwn(source, "flags")) {
      const value = source.flags;
      if (value !== undefined && value !== null) {
        recognized = true;
        best = maxImplied(best, impliedFromFlags(value));
      }
    }
    if (Object.hasOwn(source, "confidence")) {
      const value = source.confidence;
      if (value !== undefined && value !== null) {
        recognized = true;
        best = maxImplied(best, impliedFromConfidence(value));
      }
    }
    for (const key of SIMILARITY_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (value === undefined || value === null) continue;
      recognized = true;
      best = maxImplied(best, impliedFromSimilarity(value));
    }
    for (const key of GREEN_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (value === undefined || value === null) continue;
      recognized = true;
      if (value === true) best = maxImplied(best, "auto-promote");
      else if (value === false) best = maxImplied(best, "approve");
      else best = maxImplied(best, impliedFromValue(value, policy, base, depth + 1, false));
    }
    for (const key of RED_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (value === undefined || value === null) continue;
      recognized = true;
      if (value === true) best = maxImplied(best, resolveReject(policy, base));
      else if (value === false) continue;
      else best = maxImplied(best, impliedFromValue(value, policy, base, depth + 1, false));
    }
    if (Object.hasOwn(source, "requiresApproval")) {
      if (source.requiresApproval === true) {
        recognized = true;
        best = maxImplied(best, "approve");
      } else if (source.requiresApproval !== undefined && source.requiresApproval !== null) {
        recognized = true;
      }
    }
    if (!recognized && !implicit && Object.keys(source).length > 0) return "escalate";
    return best;
  }
  return "escalate";
}

function normalizeTierString(value: string): Tier | null {
  switch (tokenize(value)) {
    case "flagonly":
      return "flag-only";
    case "autopromote":
      return "auto-promote";
    case "approve":
      return "approve";
    case "escalate":
      return "escalate";
    default:
      return null;
  }
}

interface ResolvedBase {
  base: Tier;
  /** True when the caller named a classifier tier (even an invalid one). */
  explicit: boolean;
  /** True when the trailing argument was consumed as the base tier. */
  skipFirstRest: boolean;
}

/**
 * Resolve the classifier tier: a bare tier string, the first defined
 * base-tier alias on the stage output, a trailing tier-string argument, or —
 * when the output names no tier at all — the deterministic `classifyTier` of
 * the output itself. Anything else is doubt and escalates.
 */
function splitBase(top: unknown, rest: readonly unknown[]): ResolvedBase {
  if (typeof top === "string") {
    return { base: normalizeTierString(top) ?? "escalate", explicit: true, skipFirstRest: false };
  }
  if (isPlainObject(top)) {
    for (const key of BASE_TIER_KEYS) {
      if (!Object.hasOwn(top, key)) continue;
      const value = top[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") {
        return { base: "escalate", explicit: true, skipFirstRest: false };
      }
      return {
        base: normalizeTierString(value) ?? "escalate",
        explicit: true,
        skipFirstRest: false,
      };
    }
    const positional = rest.length > 0 ? rest[0] : undefined;
    if (typeof positional === "string" && positional.trim() !== "") {
      return {
        base: normalizeTierString(positional) ?? "escalate",
        explicit: true,
        skipFirstRest: true,
      };
    }
    if (positional !== undefined && positional !== null) {
      return { base: "escalate", explicit: true, skipFirstRest: true };
    }
    return { base: classifyTier(top), explicit: false, skipFirstRest: false };
  }
  return { base: "escalate", explicit: false, skipFirstRest: false };
}

/** Explicit LLM suggestion values: alias keys on the output plus trailing arguments. */
function collectSources(top: unknown, rest: readonly unknown[], skipFirstRest: boolean): unknown[] {
  const sources: unknown[] = [];
  if (isPlainObject(top)) {
    for (const key of SUGGESTION_KEYS) {
      if (!Object.hasOwn(top, key)) continue;
      const value = top[key];
      if (value !== undefined && value !== null) sources.push(value);
    }
  }
  rest.forEach((extra, index) => {
    if (skipFirstRest && index === 0) return;
    if (extra === undefined || extra === null) return;
    sources.push(extra);
  });
  return sources;
}

/** Strictest tier implied across the output's own signal keys and every explicit suggestion. */
function computeImplied(
  top: unknown,
  sources: readonly unknown[],
  policy: RejectPolicy,
  base: Tier,
): GateDecision | null {
  let best: GateDecision | null = null;
  if (isPlainObject(top)) {
    best = maxImplied(best, impliedFromValue(top, policy, base, 0, true));
  }
  for (const source of sources) {
    best = maxImplied(best, impliedFromValue(source, policy, base, 0, false));
  }
  return best;
}

/** Raw values for the given keys on the output, its one-level children, and trailing objects. */
function collectKeyValues(
  top: unknown,
  rest: readonly unknown[],
  keys: readonly string[],
): unknown[] {
  const found: unknown[] = [];
  const scan = (obj: unknown): void => {
    if (!isPlainObject(obj)) return;
    for (const key of keys) {
      if (!Object.hasOwn(obj, key)) continue;
      const value = obj[key];
      if (value !== undefined && value !== null) found.push(value);
    }
  };
  scan(top);
  if (isPlainObject(top)) {
    for (const value of Object.values(top)) scan(value);
  }
  for (const extra of rest) scan(extra);
  return found;
}

/** Promotion is withheld when verification explicitly failed. */
function isUnverified(top: unknown, rest: readonly unknown[]): boolean {
  return collectKeyValues(top, rest, UNVERIFIED_KEYS).some((value) => value === false);
}

type SimilarityStatus = "absent" | "ok" | "low";

/** Promotion similarity: absent or at-threshold passes; below threshold (or unparseable) blocks. */
function similarityStatus(top: unknown, rest: readonly unknown[]): SimilarityStatus {
  const values = collectKeyValues(top, rest, SIMILARITY_KEYS);
  let seen = false;
  for (const value of values) {
    seen = true;
    const parsed = coerceNumber(value);
    if (parsed === undefined) return "low";
    const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    if (normalized < 0 || normalized > 1) return "low";
    if (normalized < PROMOTION_SIMILARITY_THRESHOLD) return "low";
  }
  return seen ? "ok" : "absent";
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).slice(0, 80);
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text.slice(0, 80);
  } catch {
    // Circular or otherwise unserializable input: fall back to its type.
  }
  return typeof value;
}

function gateReason(
  gate: string,
  base: Tier,
  decision: GateDecision,
  overruled: boolean,
  sources: readonly unknown[],
): string {
  if (overruled) {
    return (
      `${gate} overruled llm suggestion ${describeValue(sources[0])}: ` +
      `classifier tier ${base} stands`
    );
  }
  if (rankOf(decision) > rankOf(base)) {
    return `${gate} escalated classifier tier ${base} to ${decision} on llm signal`;
  }
  if (sources.length === 0) return `${gate} keeps classifier tier ${base}: no llm suggestion`;
  return `${gate} keeps classifier tier ${base}`;
}

/**
 * Triage gate: confirm or escalate the classifier tier on instability signals
 * (cautious verdicts, instability flags, low confidence, low similarity).
 * An LLM verdict of `escalate`/`reject` escalates; a looser suggestion is
 * ignored with `overruled: true`.
 */
export function triageGate(input: unknown, ...rest: unknown[]): GateResult {
  try {
    const { base, skipFirstRest } = splitBase(input, rest);
    const sources = collectSources(input, rest, skipFirstRest);
    const implied = computeImplied(input, sources, "escalate", base);
    const decision = maxTier(base, implied ?? base);
    const overruled = sources.length > 0 && implied !== null && rankOf(implied) < rankOf(base);
    return { decision, overruled, reason: gateReason("triage", base, decision, overruled, sources) };
  } catch {
    return { decision: "escalate", overruled: false, reason: "triage gate error: escalating on doubt" };
  }
}

/**
 * Patch-review gate: an LLM `reject` (or `escalate`) verdict blocks the patch
 * — at least `approve`, or `escalate` when the classifier already required
 * approval. `proceed`/`approve` keeps the classifier tier; loosening
 * suggestions are ignored with `overruled: true`.
 */
export function patchReviewGate(input: unknown, ...rest: unknown[]): GateResult {
  try {
    const { base, skipFirstRest } = splitBase(input, rest);
    const sources = collectSources(input, rest, skipFirstRest);
    const implied = computeImplied(input, sources, "conditional", base);
    const decision = maxTier(base, implied ?? base);
    const overruled = sources.length > 0 && implied !== null && rankOf(implied) < rankOf(base);
    return {
      decision,
      overruled,
      reason: gateReason("patch-review", base, decision, overruled, sources),
    };
  } catch {
    return {
      decision: "escalate",
      overruled: false,
      reason: "patch-review gate error: escalating on doubt",
    };
  }
}

/**
 * Promotion gate: escalate-only like triage, then enforce the deterministic
 * promotion bars — promotion to `auto-promote` survives only when the
 * classifier tier is `auto-promote`, verification has not failed, and patch
 * similarity (when recorded) meets `PROMOTION_SIMILARITY_THRESHOLD`.
 * Below-threshold similarity forces at least `approve`.
 */
export function promotionGate(input: unknown, ...rest: unknown[]): GateResult {
  try {
    const { base, skipFirstRest } = splitBase(input, rest);
    const sources = collectSources(input, rest, skipFirstRest);
    const implied = computeImplied(input, sources, "escalate", base);
    let decision = maxTier(base, implied ?? base);
    let bar: string | null = null;
    if (decision === "auto-promote") {
      if (base !== "auto-promote") {
        bar = `classifier tier ${base} cannot be promoted by the llm`;
      } else if (isUnverified(input, rest)) {
        bar = "verification did not pass";
      } else if (similarityStatus(input, rest) === "low") {
        bar = `patch similarity below ${PROMOTION_SIMILARITY_THRESHOLD}`;
      }
      if (bar !== null) decision = "approve";
    }
    const overruled = sources.length > 0 && implied !== null && rankOf(implied) < rankOf(base);
    const reason =
      bar !== null
        ? `promotion withheld: ${bar}`
        : gateReason("promotion", base, decision, overruled, sources);
    return { decision, overruled, reason };
  } catch {
    return {
      decision: "escalate",
      overruled: false,
      reason: "promotion gate error: escalating on doubt",
    };
  }
}

/** Fallback invocation count for `iterationGate` calls that name no attempt. */
let fallbackInvocations = 0;

/** Reset the iteration gate's fallback counter (test isolation between loops). */
export function resetIterationGate(): void {
  fallbackInvocations = 0;
}

function coerceCount(value: unknown): number | undefined {
  let parsed: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    parsed = Math.floor(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) parsed = Math.floor(numeric);
  }
  if (parsed === undefined || parsed < 0) return undefined;
  return parsed;
}

/**
 * Iteration gate: a successful verification returns the classifier tier (or
 * `auto-promote` when no tier was named) and resets the fallback counter;
 * otherwise the attempt count — the largest explicit `attempt`-like value, or
 * the fallback counter plus one — decides: attempts before
 * `MAX_ITERATION_ATTEMPTS` return `retry` (or stricter via `maxTier` when the
 * classifier or the LLM demands it), while the `MAX_ITERATION_ATTEMPTS`-th
 * unsuccessful verification returns terminal `give-up`, which further
 * invocations keep. A loosening LLM suggestion never clears the retry state.
 */
export function iterationGate(input: unknown, ...rest: unknown[]): GateResult {
  try {
    const { base, explicit, skipFirstRest } = splitBase(input, rest);
    const succeeded = collectKeyValues(input, rest, SUCCESS_KEYS).some((value) => value === true);
    if (succeeded) {
      fallbackInvocations = 0;
      const floor: Tier = explicit ? base : "auto-promote";
      const sources = collectSources(input, rest, skipFirstRest);
      const implied = computeImplied(input, sources, "escalate", floor);
      const decision = maxTier(floor, implied ?? floor);
      const overruled =
        sources.length > 0 && implied !== null && rankOf(implied) < rankOf(floor);
      return {
        decision,
        overruled,
        reason:
          rankOf(decision) > rankOf(floor)
            ? `iteration verified but llm signal holds at ${decision}`
            : "iteration verified",
      };
    }
    let explicitCount: number | undefined;
    for (const value of collectKeyValues(input, rest, COUNT_KEYS)) {
      const parsed = coerceCount(value);
      if (parsed !== undefined) {
        explicitCount = explicitCount === undefined ? parsed : Math.max(explicitCount, parsed);
      }
    }
    const count = Math.max(explicitCount ?? 0, fallbackInvocations + 1);
    fallbackInvocations = Math.min(count, MAX_ITERATION_ATTEMPTS);
    if (count >= MAX_ITERATION_ATTEMPTS) {
      return {
        decision: "give-up",
        overruled: false,
        reason: `iteration budget exhausted at attempt ${count} of ${MAX_ITERATION_ATTEMPTS}`,
      };
    }
    const sources = collectSources(input, rest, skipFirstRest);
    const implied = computeImplied(input, sources, "escalate", base);
    const floor = maxTier(base, implied ?? base);
    const decision: GateDecision = rankOf(floor) >= rankOf("approve") ? floor : "retry";
    const overruled = sources.length > 0 && implied !== null && rankOf(implied) < rankOf(base);
    return {
      decision,
      overruled,
      reason:
        `attempt ${count} of ${MAX_ITERATION_ATTEMPTS} unverified: ` +
        (overruled
          ? `llm loosening overruled, ${decision}`
          : `withholding promotion (${decision})`),
    };
  } catch {
    return {
      decision: "escalate",
      overruled: false,
      reason: "iteration gate error: escalating on doubt",
    };
  }
}
