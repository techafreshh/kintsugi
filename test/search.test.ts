import { describe, expect, it, vi } from "vitest";
import { createSearchPort, NoopSearchPort, type SearchPort } from "../src/search/port.js";
import {
  DEFAULT_TINYFISH_API_BASE_URL,
  TinyFishSearch,
} from "../src/search/tinyfish.js";
import { sanitizeSearchResult } from "../src/security/sanitize.js";

/** Minimal Response-shaped stub: status + text(). */
function stubResponse(status: number, body: string) {
  return { status, text: async () => body };
}

function capturingFetch(handler: (url: string, init: unknown) => unknown) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchFn = (async (url: string, init: unknown) => {
    calls.push({ url, init });
    return handler(url, init) as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function headersOf(init: unknown): Record<string, string> {
  return ((init as { headers?: Record<string, string> }).headers ?? {}) as Record<string, string>;
}

describe("NoopSearchPort: offline default", () => {
  it("returns [] and never touches fetch (instrumented global fetch observes zero calls)", async () => {
    const spy = vi.fn(async () => stubResponse(200, "{}") as unknown as Response);
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = spy;
    try {
      const port = new NoopSearchPort();
      expect(port.name).toBe("noop");
      await expect(port.search("anything")).resolves.toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createSearchPort factory", () => {
  it("returns the no-op port when TINYFISH_API_KEY is unset or blank", () => {
    for (const env of [{}, { TINYFISH_API_KEY: "" }, { TINYFISH_API_KEY: "  " }]) {
      const port = createSearchPort(env as NodeJS.ProcessEnv);
      expect(port).toBeInstanceOf(NoopSearchPort);
      expect(port.name).toBe("noop");
    }
  });

  it("returns the TinyFish adapter when TINYFISH_API_KEY is set", () => {
    const port: SearchPort = createSearchPort({ TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(TinyFishSearch);
    expect(port.name).toBe("tinyfish");
  });
});

describe("TinyFishSearch constructor", () => {
  it("throws TypeError when the key is missing or blank", () => {
    for (const env of [{}, { TINYFISH_API_KEY: "" }, { TINYFISH_API_KEY: "   " }]) {
      expect(() => new TinyFishSearch(env as NodeJS.ProcessEnv)).toThrow(TypeError);
    }
  });

  it("defaults the base URL and honors TINYFISH_API_BASE_URL with slash-trimming", () => {
    expect(
      new TinyFishSearch({ TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv).resolveBaseUrl(),
    ).toBe(DEFAULT_TINYFISH_API_BASE_URL);
    expect(DEFAULT_TINYFISH_API_BASE_URL).toBe("https://agent.tinyfish.ai");
    expect(
      new TinyFishSearch({
        TINYFISH_API_KEY: "k",
        TINYFISH_API_BASE_URL: "https://api.search.tinyfish.ai///",
      } as NodeJS.ProcessEnv).resolveBaseUrl(),
    ).toBe("https://api.search.tinyfish.ai");
  });
});

describe("TinyFishSearch transport", () => {
  it("sends Bearer + X-API-Key headers with the query param on the base URL", async () => {
    const { fetchFn, calls } = capturingFetch(() =>
      stubResponse(200, JSON.stringify({ results: [{ title: "t", url: "u", snippet: "s" }] })),
    );
    const port = new TinyFishSearch({ TINYFISH_API_KEY: "secret" } as NodeJS.ProcessEnv, fetchFn);
    await expect(port.search("n8n workflow failure")).resolves.toEqual([
      { title: "t", url: "u", snippet: "s" },
    ]);
    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: unknown };
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${DEFAULT_TINYFISH_API_BASE_URL}/`);
    expect(url.searchParams.get("query")).toBe("n8n workflow failure");
    const headers = headersOf(call.init);
    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["x-api-key"]).toBe("secret");
  });

  it("honors a base override so api.search.tinyfish.ai matches the documented shape", async () => {
    const { fetchFn, calls } = capturingFetch(() => stubResponse(200, JSON.stringify({ results: [] })));
    const port = new TinyFishSearch(
      {
        TINYFISH_API_KEY: "secret",
        TINYFISH_API_BASE_URL: "https://api.search.tinyfish.ai",
      } as NodeJS.ProcessEnv,
      fetchFn,
    );
    await port.search("web automation tools");
    expect(calls).toHaveLength(1);
    const url = new URL((calls[0] as { url: string }).url);
    expect(url.origin).toBe("https://api.search.tinyfish.ai");
    expect(url.searchParams.get("query")).toBe("web automation tools");
  });

  it("slices to the top 5 and coerces non-string fields to empty strings", async () => {
    const results = Array.from({ length: 7 }, (_, index) => ({
      title: `t${index}`,
      url: 42,
      snippet: null,
      extra: "dropped",
    }));
    const { fetchFn } = capturingFetch(() => stubResponse(200, JSON.stringify({ results })));
    const port = new TinyFishSearch({ TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv, fetchFn);
    const hits = await port.search("q");
    expect(hits).toHaveLength(5);
    expect(hits[0]).toEqual({ title: "t0", url: "", snippet: "" });
  });

  it("never throws on parse: malformed bodies yield []", async () => {
    for (const body of ["not json{{{", "{}", '{"results":null}', '{"results":{}}', "[]"]) {
      const { fetchFn } = capturingFetch(() => stubResponse(200, body));
      const port = new TinyFishSearch({ TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv, fetchFn);
      await expect(port.search("q")).resolves.toEqual([]);
    }
  });

  it("throws on non-2xx and wraps low-level failures with a cause", async () => {
    const { fetchFn: bad } = capturingFetch(() => stubResponse(500, "boom"));
    await expect(
      new TinyFishSearch({ TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv, bad).search("q"),
    ).rejects.toThrow(/returned 500/);
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    let error: unknown;
    try {
      await new TinyFishSearch(
        { TINYFISH_API_KEY: "k" } as NodeJS.ProcessEnv,
        failing,
      ).search("q");
      expect.unreachable("search should have thrown");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/tinyfish: search failed/);
  });
});

describe("sanitizeSearchResult", () => {
  it("sanitizes string fields and coerces non-strings to empty", () => {
    expect(
      sanitizeSearchResult({ title: "Hello \u200BWorld", url: "https://x.example", snippet: 42 }),
    ).toEqual({ title: "Hello World", url: "https://x.example", snippet: "" });
    expect(sanitizeSearchResult(null)).toEqual({ title: "", url: "", snippet: "" });
    expect(sanitizeSearchResult("nope")).toEqual({ title: "", url: "", snippet: "" });
  });
});
