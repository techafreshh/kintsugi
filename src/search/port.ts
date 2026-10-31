/**
 * Pinned contract (issue #76): the `SearchPort` behind which all diagnose
 * web-search enrichment sits. `search` returns sanitized-ready result
 * candidates (title/url/snippet); the diagnose stage decides when to call it
 * (unknown `failure_class` or `confidence < 0.6` only) and audits every call
 * in `llm_traces`. `createSearchPort` is the orchestrator switch-point: it
 * returns the TinyFish adapter when `TINYFISH_API_KEY` is set and a
 * zero-network no-op fake otherwise, so enrichment stays offline by default.
 */

import { TinyFishSearch } from "./tinyfish.js";

/** One web-search hit offered as diagnose evidence (fields sanitized by the caller). */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Web-search boundary for diagnose enrichment. `query` is opaque to the port
 * (a capped keyword string built from the first verdict); the no-op port
 * ignores it entirely.
 */
export interface SearchPort {
  /** Human-readable implementation label; the no-op reports `"noop"`. */
  readonly name: string;
  /** Top search hits for the query (at most 5 from the TinyFish adapter). */
  search(query: string): Promise<SearchResult[]>;
}

/**
 * Offline default (issue #76): selected whenever `TINYFISH_API_KEY` is
 * unset/blank. Returns `[]` without touching the network — it holds no key,
 * no base URL, and no `fetch` reference, so an instrumented global `fetch`
 * observes zero calls.
 */
export class NoopSearchPort implements SearchPort {
  readonly name = "noop";

  async search(_query: string): Promise<SearchResult[]> {
    return [];
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Orchestrator switch-point with an injectable env map (mirroring
 * `createLLM` in `src/llm/port.ts`, so tests never touch `process.env`
 * directly). A non-blank `TINYFISH_API_KEY` returns the live TinyFish
 * adapter; every other case returns the zero-network no-op port.
 */
export function createSearchPort(env: NodeJS.ProcessEnv = process.env): SearchPort {
  if (trimmed(env.TINYFISH_API_KEY) !== "") {
    return new TinyFishSearch(env);
  }
  return new NoopSearchPort();
}
