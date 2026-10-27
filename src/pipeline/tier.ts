/**
 * Pinned contract (issue #13): deterministic risk classification from LLM
 * verdict flags alone. `classifyTier(verdict)` maps only the verdict's
 * flags plus the confidence/scope/reversible gates to
 * `flag-only` / `approve` / `auto-promote` / `escalate`, escalating to the
 * stricter tier on any doubt. Pure over untrusted data: never throws, never
 * mutates its inputs, no dependencies. The orchestrator calls it after the
 * judge step; the classifier never loosens another tier.
 */

/** Risk tier; `escalate` is the strictest outcome and a real return value. */
export type Tier = "flag-only" | "approve" | "auto-promote" | "escalate";

/** Verdict shape the classifier reads; extra fields are ignored. */
export interface TierVerdict {
  flags?: unknown;
  confidence?: unknown;
  scope?: unknown;
  reversible?: unknown;
  requiresApproval?: unknown;
}

/** Confidence below this (or missing/non-finite/non-number) escalates. */
export const TIER_CONFIDENCE_THRESHOLD = 0.8;

/** Flags describing a safe, scoped, reversible patch. */
export const SAFE_FLAGS: ReadonlySet<string> = new Set([
  "safe-value-fix",
  "safe-expression-fix",
  "retry-backoff",
  "on-error-continue",
]);

/** Flags describing work that needs a human confirmation. */
export const APPROVE_FLAGS: ReadonlySet<string> = new Set([
  "touches-code",
  "touches-logic",
  "adds-node",
  "removes-node",
  "large-diff",
  "touches-credentials",
  "touches-trigger",
  "touches-webhook",
  "sends-external",
  "deletes-data",
]);

/**
 * Classify a judge verdict into a risk tier. Never throws: any malformed
 * input (non-object verdict, non-array flags, non-string flag entry,
 * missing/non-finite/below-threshold confidence, or unexpected
 * scope/reversible/requiresApproval types) returns `escalate`.
 * Precedence: malformed/low-confidence -> `escalate`; empty flags without
 * scope expansion -> `flag-only`; unknown flag -> `escalate`; mixed
 * safe+approve flags -> `escalate`; any approve flag or
 * `requiresApproval === true` -> `approve`; all-safe flags with
 * `scope === "affected-nodes-only"` and `reversible === true` ->
 * `auto-promote`; anything else -> `escalate`.
 */
export function classifyTier(verdict: unknown): Tier {
  try {
    if (!isPlainObject(verdict)) return "escalate";

    const confidence = verdict.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < TIER_CONFIDENCE_THRESHOLD ||
      confidence > 1
    ) {
      return "escalate";
    }

    const rawFlags = verdict.flags;
    if (!Array.isArray(rawFlags)) return "escalate";
    const flags: string[] = [];
    for (const entry of rawFlags) {
      if (typeof entry !== "string") return "escalate";
      flags.push(entry);
    }

    const scope = verdict.scope;
    if (scope !== undefined && typeof scope !== "string") return "escalate";
    const reversible = verdict.reversible;
    if (reversible !== undefined && typeof reversible !== "boolean") return "escalate";
    const requiresApproval = verdict.requiresApproval;
    if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
      return "escalate";
    }

    for (const flag of flags) {
      if (!SAFE_FLAGS.has(flag) && !APPROVE_FLAGS.has(flag)) return "escalate";
    }

    const expanded = scope !== undefined && scope !== "none" && scope !== "affected-nodes-only";

    if (flags.length === 0) {
      if (requiresApproval === true) return "approve";
      if (expanded) return "escalate";
      return "flag-only";
    }

    let hasSafe = false;
    let hasApprove = false;
    for (const flag of flags) {
      if (SAFE_FLAGS.has(flag)) hasSafe = true;
      if (APPROVE_FLAGS.has(flag)) hasApprove = true;
    }
    if (hasSafe && hasApprove) return "escalate";
    if (hasApprove || requiresApproval === true) return "approve";
    if (hasSafe && scope === "affected-nodes-only" && reversible === true) {
      return "auto-promote";
    }
    return "escalate";
  } catch {
    return "escalate";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
