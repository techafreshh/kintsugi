import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/store/store.js";
import { MockLLM } from "../src/llm/mock.js";
import { TracedLLM, createTracedLLM, withTraces } from "../src/llm/traced.js";
import { diagnose } from "../src/pipeline/diagnose.js";
import { runPatchStage } from "../src/pipeline/patch.js";
import { buildWorkflowView, type WorkflowView } from "../src/llm/workflowView.js";
import { diagnoseVerdictSchema, type DiagnoseVerdict } from "../src/llm/schemas.js";
import type { LLMPort } from "../src/llm/port.js";

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

function seedWorkflow(): Record<string, unknown> {
  return {
    id: "wf-1",
    name: "test-flow",
    nodes: [
      { name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
      { name: "HttpRequest", type: "n8n-nodes-base.httpRequest", typeVersion: 1, position: [200, 0], parameters: { url: "https://example.com/api" } },
      { name: "Set", type: "n8n-nodes-base.set", typeVersion: 1, position: [400, 0], parameters: { value: "={{ $json.old }}" } },
    ],
    connections: {
      Start: { main: [[{ node: "HttpRequest", type: "main", index: 0 }]] },
      HttpRequest: { main: [[{ node: "Set", type: "main", index: 0 }]] },
    },
  };
}

function seedRunData(): unknown {
  return {
    resultData: {
      runData: {
        Start: [{ data: { main: [[{ json: { a: 1 } }]] } }],
        Set: [{ data: { main: [[{ json: { a: 1 } }]] }, error: { message: "boom" } }],
      },
    },
  };
}

function cleanView(): WorkflowView {
  return buildWorkflowView(seedWorkflow(), seedRunData());
}

function mockEnv(): NodeJS.ProcessEnv {
  return { MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv;
}

describe("traced diagnose row", () => {
  it("a diagnose call through the wrapper leaves a diagnose row with mode mock and numeric duration_ms", async () => {
    const traced = withTraces(new MockLLM(mockEnv()), store, "e-diagnose");
    expect(traced).toBeInstanceOf(TracedLLM);
    expect(traced.name).toBe("mock");
    expect(traced.mode).toBe("mock");
    const verdict = await diagnose(traced, cleanView());
    expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("schema-drift");
    const rows = store.listTraces("e-diagnose");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((entry) => entry.stage === "diagnose");
    expect(row).toBeDefined();
    expect(row?.llmMode).toBe("mock");
    expect(typeof row?.durationMs).toBe("number");
    expect(Number.isFinite(row?.durationMs ?? NaN)).toBe(true);
  });
});

describe("trace text capping", () => {
  it("a 100,000-char prompt is stored capped at 8000 chars for prompt and response", async () => {
    const traced = withTraces(new MockLLM(mockEnv()), store, "e-cap");
    await traced.submit_verdict("diagnose", "p".repeat(100_000), diagnoseVerdictSchema);
    const rows = store.listTraces("e-cap");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt.length).toBeLessThanOrEqual(8000);
    expect(rows[0]?.response.length).toBeLessThanOrEqual(8000);
    expect(rows[0]?.prompt).toHaveLength(8000);
  });
});

describe("diagnose plus patch rows", () => {
  it("diagnose and patch calls leave rows for both stages with non-null models", async () => {
    const traced = withTraces(new MockLLM(mockEnv()), store, "e-both");
    const workflow = seedWorkflow();
    const diagnosis = await diagnose(traced, cleanView());
    const patched = await runPatchStage({ workflow, diagnose: diagnosis, llm: traced });
    expect(patched.workflow).toBeDefined();
    const rows = store.listTraces("e-both");
    const stages = rows.map((entry) => entry.stage);
    expect(stages).toContain("diagnose");
    expect(stages).toContain("patch");
    for (const entry of rows) {
      expect(typeof entry.model).toBe("string");
      expect(entry.model.length).toBeGreaterThan(0);
    }
  });
});

describe("traced failure audit", () => {
  it("a failed inner call still writes a trace row with the error and rethrows", async () => {
    const failing: LLMPort = {
      name: "failing",
      mode: "mock",
      submit_verdict: async () => {
        throw new Error("llm down");
      },
    };
    const traced = withTraces(failing, store, "e-fail");
    await expect(traced.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow(
      "llm down",
    );
    const rows = store.listTraces("e-fail");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stage).toBe("diagnose");
    expect(rows[0]?.verdict).toBeNull();
    expect(rows[0]?.error).toBe("llm down");
  });

  it("a store throw on success never masks the verdict", async () => {
    const verdict = {
      rootCauseKind: "schema-drift",
      failureClass: "upstream schema change",
      affectedNodes: ["Set"],
      reasoning: "r",
      confidence: 0.5,
    };
    const inner: LLMPort = {
      name: "mock",
      mode: "mock",
      submit_verdict: async () => verdict as never,
    };
    const broken = {
      insertTrace: (): never => {
        throw new Error("store down");
      },
      listTraces: (): [] => [],
    } as unknown as Store;
    const traced = withTraces(inner, broken, "e-swallow");
    await expect(
      traced.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema),
    ).resolves.toEqual(verdict);
  });
});

describe("traced factory", () => {
  it("createTracedLLM composes the mock with tracing for the event", async () => {
    const traced = createTracedLLM(mockEnv(), store, "e-factory");
    expect(traced.mode).toBe("mock");
    await traced.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(store.listTraces("e-factory")).toHaveLength(1);
  });
});
