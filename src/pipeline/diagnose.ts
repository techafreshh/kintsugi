/**
 * Pinned contract (issue #11, extended by issue #76): the diagnose stage of
 * the repair loop. `diagnose(llm, view)` builds the hardened prompt via
 * `buildDiagnosePrompt`, calls `submit_verdict("diagnose", prompt,
 * diagnoseVerdictSchema)`, validates the raw verdict with `Value.Check`,
 * throws loudly on mismatch, and returns the narrowed verdict. Never
 * mutates `view`.
 *
 * Issue #76 adds an optional second pass: when the first verdict needs help
 * (unknown `failure_class` or `confidence < 0.6`) and a `SearchPort` is
 * provided, the stage searches the web, sanitizes the top-5 hits, re-prompts
 * the LLM with the evidence inside the existing `<data>` boundary, and
 * returns the re-validated second verdict. Search failures degrade to the
 * first verdict; enrichment never touches tier/classifier/gate inputs.
 */

import { Value } from "@sinclair/typebox/value";
import type { LLMPort } from "../llm/port.js";
import { buildDiagnosePrompt, buildEnrichedDiagnosePrompt } from "../llm/prompts.js";
import { diagnoseVerdictSchema, type DiagnoseVerdict } from "../llm/schemas.js";
import type { WorkflowView } from "../llm/workflowView.js";
import { sanitizeSearchResult } from "../security/sanitize.js";
import type { SearchPort, SearchResult } from "../search/port.js";
import type { Store } from "../store/store.js";

/** Optional third argument to `diagnose`; fully backward compatible. */
export interface DiagnoseOptions {
  /** Web-search port; when absent, low-confidence verdicts return as-is. */
  search?: SearchPort;
  /** Store for the stage-`search` audit row; needs `eventId` to take effect. */
  store?: Store;
  /** Event id the stage-`search` audit row is recorded under. */
  eventId?: string;
}

/** Confidence below which the first verdict is considered to need help. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Enrichment query cap so hostile verdict fields cannot blow up the request. */
const SEARCH_QUERY_CAP = 500;

/** Stored prompt/response cap for the stage-`search` row (mirrors `TRACE_TEXT_CAP`). */
const SEARCH_TRACE_CAP = 8_000;

/**
 * Whether the first verdict needs web help: `confidence < 0.6`, or a blank
 * or `"unknown"` (case-insensitive) `failure_class`. Never throws.
 */
export function needsEnrichment(verdict: DiagnoseVerdict): boolean {
  try {
    if (typeof verdict.confidence === "number" && verdict.confidence < LOW_CONFIDENCE_THRESHOLD) {
      return true;
    }
    const failureClass =
      typeof verdict.failureClass === "string" ? verdict.failureClass.trim() : "";
    return failureClass === "" || failureClass.toLowerCase() === "unknown";
  } catch {
    return false;
  }
}

/**
 * Enrichment query from the first verdict: `[failureClass, affectedNodes,
 * rootCauseKind]` joined, capped at 500 chars; `"n8n workflow failure"` when
 * every part is empty. Never throws.
 */
export function buildSearchQuery(verdict: DiagnoseVerdict): string {
  try {
    const parts: string[] = [];
    if (typeof verdict.failureClass === "string" && verdict.failureClass.trim() !== "") {
      parts.push(verdict.failureClass.trim());
    }
    if (Array.isArray(verdict.affectedNodes)) {
      const nodes = verdict.affectedNodes
        .filter((node): node is string => typeof node === "string" && node.trim() !== "")
        .map((node) => node.trim())
        .join(" ");
      if (nodes !== "") parts.push(nodes);
    }
    if (typeof verdict.rootCauseKind === "string" && verdict.rootCauseKind.trim() !== "") {
      parts.push(verdict.rootCauseKind.trim());
    }
    const joined = parts.join(" ").trim();
    const query = joined === "" ? "n8n workflow failure" : joined;
    return query.length <= SEARCH_QUERY_CAP ? query : query.slice(0, SEARCH_QUERY_CAP);
  } catch {
    return "n8n workflow failure";
  }
}

/** Cap stored text at the wrapper-layer 8000-char limit. */
function capText(value: string): string {
  return value.length <= SEARCH_TRACE_CAP ? value : value.slice(0, SEARCH_TRACE_CAP);
}

/** Rough token estimate from stored text length (`ceil(chars/4)`). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Evidence line per hit; fields are already sanitized, never throws. */
function evidenceLine(result: { title: string; url: string; snippet: string }): string {
  return `- ${result.title} (${result.url}): ${result.snippet}`;
}

/**
 * Run the diagnose stage: prompt the LLM with the hardened workflow-view
 * prompt and return the validated verdict, enriched via web search when the
 * first verdict needs help and a `search` port is provided.
 */
export async function diagnose(
  llm: LLMPort,
  view: WorkflowView,
  options?: DiagnoseOptions,
): Promise<DiagnoseVerdict> {
  const prompt = buildDiagnosePrompt(view);
  const raw = await llm.submit_verdict("diagnose", prompt, diagnoseVerdictSchema);
  if (!Value.Check(diagnoseVerdictSchema, raw)) {
    throw new Error("diagnose: LLM verdict failed diagnoseVerdictSchema validation");
  }
  const verdict = raw as DiagnoseVerdict;

  const search = options?.search;
  if (search === undefined || !needsEnrichment(verdict)) return verdict;

  const query = buildSearchQuery(verdict);
  const startedAt = Date.now();
  let results: SearchResult[];
  try {
    results = await search.search(query);
  } catch {
    // Enrichment is best-effort: a search failure keeps the first verdict
    // and records no trace row.
    return verdict;
  }
  const durationMs = Math.max(0, Math.round(Date.now() - startedAt));

  const top = (Array.isArray(results) ? results : []).slice(0, 5);
  const cleaned = top.map((entry) => sanitizeSearchResult(entry));
  const evidence = cleaned.map(evidenceLine).join("\n");

  // Audit the search call itself (stage exactly `"search"`); only for real
  // ports — the no-op port returns `[]` with nothing to audit, and a search
  // failure above already returned. Best-effort: a store throw never masks
  // the verdict.
  if (
    options?.store !== undefined &&
    options?.eventId !== undefined &&
    search.name !== "noop"
  ) {
    try {
      options.store.insertTrace({
        eventId: options.eventId,
        stage: "search",
        model: "tinyfish",
        llmMode: search.name === "noop" ? "mock" : "live",
        durationMs,
        tokensIn: estimateTokens(query),
        tokensOut: estimateTokens(evidence),
        prompt: capText(query),
        response: capText(evidence),
        verdict: cleaned,
        error: null,
      });
    } catch {
      // Trace writes are best-effort; the verdict still returns.
    }
  }

  if (cleaned.length === 0) return verdict;

  const enriched = buildEnrichedDiagnosePrompt(view, evidence);
  const second = await llm.submit_verdict("diagnose", enriched, diagnoseVerdictSchema);
  if (!Value.Check(diagnoseVerdictSchema, second)) {
    throw new Error("diagnose: LLM verdict failed diagnoseVerdictSchema validation");
  }
  return second as DiagnoseVerdict;
}
