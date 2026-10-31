/**
 * Pinned contract (issue #76): `TinyFishSearch` implements `SearchPort` on
 * top of the TinyFish Search API via the global `fetch`. The base URL is
 * `https://agent.tinyfish.ai` unless `TINYFISH_API_BASE_URL` overrides it
 * (point it at `https://api.search.tinyfish.ai` to match the public Search
 * API shape documented at `docs.tinyfish.ai/search-api`); the request appends
 * the `query` param to the base as-is. Auth sends both the issue-pinned
 * `Authorization: Bearer <key>` header and the live-docs `X-API-Key: <key>`
 * header so the same adapter satisfies the issue contract and the real
 * Search API. Transport mirrors `src/n8n/client.ts`: pinned headers,
 * `AbortSignal.timeout` deadline, low-level failures wrapped in `Error` with
 * `{ cause }`, non-2xx answered as a contextual `Error`. Parsing is
 * tolerant: a missing/non-array `results` body (or a non-JSON 2xx body)
 * yields `[]` instead of throwing; at most 5 entries are returned with
 * non-string fields coerced to `""`. Configuration is constructor-injected —
 * this module never reads `process.env` except through its defaulted `env`
 * parameter — and the `fetch` function is injectable so tests run with zero
 * network.
 */

import type { SearchPort, SearchResult } from "./port.js";

/** Issue-pinned default base; overridable via `TINYFISH_API_BASE_URL`. */
export const DEFAULT_TINYFISH_API_BASE_URL = "https://agent.tinyfish.ai";

/** Per-request deadline mirroring `src/n8n/client.ts`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Max results returned per call; the diagnose stage sanitizes the top 5. */
const MAX_RESULTS = 5;

/**
 * Absent, empty, or whitespace-only values mean "unset" (mirrors
 * blank-falls-through in `loadSettings`); returns the trimmed value otherwise.
 */
function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value;
}

function truncate(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 200);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tolerantly pick the results array out of a parsed 2xx body. */
function pickResults(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const results = (body as Record<string, unknown>).results;
    if (Array.isArray(results)) return results;
  }
  return [];
}

export class TinyFishSearch implements SearchPort {
  readonly name = "tinyfish";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = globalThis.fetch) {
    const apiKey = optionalString(env.TINYFISH_API_KEY);
    if (apiKey === undefined) {
      throw new TypeError("tinyfish: TINYFISH_API_KEY is required for live search");
    }
    this.apiKey = apiKey;
    this.baseUrl = (optionalString(env.TINYFISH_API_BASE_URL) ?? DEFAULT_TINYFISH_API_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchFn = fetchFn;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  /** Base URL after trim + trailing-slash stripping (tests assert overrides). */
  resolveBaseUrl(): string {
    return this.baseUrl;
  }

  async search(query: string): Promise<SearchResult[]> {
    const text = typeof query === "string" ? query : "";
    const url = new URL(this.baseUrl);
    url.searchParams.set("query", text);
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "x-api-key": this.apiKey,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new Error(`tinyfish: search failed (${describe(cause)})`, { cause });
    }
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (cause) {
      throw new Error(`tinyfish: search failed (${describe(cause)})`, { cause });
    }
    if (response.status < 200 || response.status > 299) {
      throw new Error(`tinyfish: search returned ${response.status}: ${truncate(bodyText)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return [];
    }
    return pickResults(parsed)
      .slice(0, MAX_RESULTS)
      .map((entry): SearchResult => {
        const record =
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)
            : {};
        return {
          title: asString(record.title),
          url: asString(record.url),
          snippet: asString(record.snippet),
        };
      });
  }
}
