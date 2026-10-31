import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { openStore, type Store } from "../src/store/store.js";
import { buildWorkflowView, type WorkflowView } from "../src/llm/workflowView.js";
import { diagnoseVerdictSchema, type DiagnoseVerdict } from "../src/llm/schemas.js";
import type { LlmStage, LLMPort } from "../src/llm/port.js";
import { diagnose } from "../src/pipeline/diagnose.js";
import { NoopSearchPort, type SearchPort, type SearchResult } from "../src/search/port.js";

/** Scripted LLM: replays queued verdicts and captures every prompt. */
class ScriptLLM implements LLMPort {
  readonly name = "script";
  readonly mode = "mock" as const;
  readonly prompts: unknown[] = [];

  constructor(private readonly verdicts: unknown[]) {}

  async submit_verdict<T extends TSchema>(
    _stage: LlmStage,
    prompt: unknown,
    schema: T,
  ): Promise<Static<T>> {
    this.prompts.push(prompt);
    const next = this.verdicts.shift();
    if (!Value.Check(schema, next)) throw new Error("script LLM fixture failed validation");
    return next as Static<T>;
  }
}

/** Fake search port: records queries, returns canned hits, touches no network. */
class FakeSearch implements SearchPort {
  readonly name = "fake";
  readonly queries: string[] = [];

  constructor(private readonly hits: SearchResult[]) {}

  async search(query: string): Promise<SearchResult[]> {
    this.queries.push(query);
    return this.hits;
  }
}

function lowConfUnknown(): DiagnoseVerdict {
  return {
    rootCauseKind: "schema-drift",
    failureClass: "unknown",
    affectedNodes: ["Set"],
    reasoning: "Not sure what broke.",
    confidence: 0.4,
  };
}

function highConfKnown(): DiagnoseVerdict {
  return {
    rootCauseKind: "schema-drift",
    failureClass: "upstream schema change",
    affectedNodes: ["HttpRequest", "Set"],
    reasoning: "Upstream renamed a field.",
    confidence: 0.9,
  };
}

function fiveHits(): SearchResult[] {
  return [
    { title: "First Title n8n Set mapping", url: "https://a.example/1", snippet: "Map renamed fields." },
    { title: "Second hit", url: "https://a.example/2", snippet: "Retry with backoff." },
    { title: "Third hit", url: "https://a.example/3", snippet: "Check the trigger." },
    { title: "Fourth hit", url: "https://a.example/4", snippet: "Inspect run data." },
    { title: "Fifth hit", url: "https://a.example/5", snippet: "Verify the patch." },
  ];
}

function cleanView(): WorkflowView {
  const wf = {
    nodes: [
      { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { name: "Set", type: "n8n-nodes-base.set", parameters: { value: "={{ $json.a }}" } },
    ],
    connections: { Start: { main: [[{ node: "Set", type: "main", index: 0 }]] } },
  };
  const run = {
    data: {
      resultData: {
        runData: {
          Start: [{ data: { main: [[{ json: { a: 1 } }]] } }],
          Set: [{ data: { main: [[{ json: { a: 1 } }]] }, error: { message: "boom" } }],
        },
      },
    },
  };
  return buildWorkflowView(wf, run);
}

function searchTraces(store: Store, eventId: string) {
  return store.listTraces(eventId).filter((trace) => trace.stage === "search");
}

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("diagnose enrichment: low confidence + 5 fake hits", () => {
  it("re-prompts inside <data> with the first title and records one stage-search trace", async () => {
    const llm = new ScriptLLM([lowConfUnknown(), highConfKnown()]);
    const search = new FakeSearch(fiveHits());
    const verdict = await diagnose(llm, cleanView(), { search, store, eventId: "e-low" });
    expect(verdict.confidence).toBe(0.9);
    expect(search.queries).toHaveLength(1);
    expect(llm.prompts).toHaveLength(2);
    const enriched = llm.prompts[1] as string;
    expect(enriched).toContain("<data>");
    expect(enriched).toContain("First Title n8n Set mapping");
    const traces = searchTraces(store, "e-low");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.stage).toBe("search");
  });
});

describe("diagnose offline: no-op port with confidence 0.4", () => {
  it("makes zero outbound calls and records zero search rows, returning the first verdict", async () => {
    const fetchCalls: unknown[] = [];
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = ((async (...args: unknown[]) => {
      fetchCalls.push(args);
      throw new Error("network must stay untouched");
    }) as unknown as typeof fetch);
    try {
      const llm = new ScriptLLM([lowConfUnknown()]);
      const verdict = await diagnose(llm, cleanView(), {
        search: new NoopSearchPort(),
        store,
        eventId: "e-offline",
      });
      expect(verdict.confidence).toBe(0.4);
      expect(llm.prompts).toHaveLength(1);
      expect(fetchCalls).toHaveLength(0);
      expect(searchTraces(store, "e-offline")).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("diagnose non-trigger: confidence 0.9 with a known failure_class", () => {
  it("never calls search and records zero search rows", async () => {
    const llm = new ScriptLLM([highConfKnown()]);
    const search = new FakeSearch(fiveHits());
    const verdict = await diagnose(llm, cleanView(), { search, store, eventId: "e-high" });
    expect(verdict.confidence).toBe(0.9);
    expect(search.queries).toHaveLength(0);
    expect(llm.prompts).toHaveLength(1);
    expect(searchTraces(store, "e-high")).toHaveLength(0);
  });

  it("a high-confidence unknown failure_class still triggers enrichment", async () => {
    const llm = new ScriptLLM([
      { ...highConfKnown(), failureClass: "Unknown", confidence: 0.95 },
      highConfKnown(),
    ]);
    const search = new FakeSearch(fiveHits());
    await diagnose(llm, cleanView(), { search, store, eventId: "e-unknown" });
    expect(search.queries).toHaveLength(1);
    expect(searchTraces(store, "e-unknown")).toHaveLength(1);
  });
});

describe("diagnose search failure degrades to the first verdict", () => {
  it("a throwing port yields the first verdict with no trace row", async () => {
    const llm = new ScriptLLM([lowConfUnknown()]);
    const failing: SearchPort = {
      name: "failing",
      search: async () => {
        throw new Error("search down");
      },
    };
    const verdict = await diagnose(llm, cleanView(), { search: failing, store, eventId: "e-throw" });
    expect(verdict.confidence).toBe(0.4);
    expect(llm.prompts).toHaveLength(1);
    expect(searchTraces(store, "e-throw")).toHaveLength(0);
  });
});

describe("diagnose without a search port stays single-pass", () => {
  it("low confidence alone never triggers enrichment when no port is provided", async () => {
    const llm = new ScriptLLM([lowConfUnknown()]);
    const verdict = await diagnose(llm, cleanView(), { store, eventId: "e-noport" });
    expect(verdict.confidence).toBe(0.4);
    expect(llm.prompts).toHaveLength(1);
    expect(searchTraces(store, "e-noport")).toHaveLength(0);
  });
});
