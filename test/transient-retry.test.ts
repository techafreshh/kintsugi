import { describe, expect, it } from "vitest";
import { MockLLM } from "../src/llm/mock.js";
import { diagnoseVerdictSchema, judgeVerdictSchema, patchVerdictSchema, validate } from "../src/llm/schemas.js";
import { applyPatchOps } from "../src/patch/patchOps.js";

function chain(): Record<string, unknown> {
  return {
    id: "wf-transient",
    name: "transient-chain",
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 1, position: [0, 0], parameters: {} },
      { name: "HttpRequest", type: "n8n-nodes-base.httpRequest", typeVersion: 1, position: [200, 0], parameters: { url: "https://example.com/api" } },
      { name: "Set", type: "n8n-nodes-base.set", typeVersion: 1, position: [400, 0], parameters: { value: "={{ $json.old }}" } },
    ],
    connections: {},
  };
}

function envFor(scenario: string): NodeJS.ProcessEnv {
  return { MOCK_LLM_SCENARIO: scenario } as NodeJS.ProcessEnv;
}

describe("transient-429 retry patch", () => {
  it("set_retry writes retryOnFail, retries, and the maxTries alias on the addressed node only", () => {
    const after = applyPatchOps(chain(), [
      { op: "set_retry", nodeId: "HttpRequest", retries: 3, retryOnFail: true },
    ]);
    const nodes = after.nodes as Array<Record<string, unknown>>;
    expect(nodes.find((node) => node.name === "HttpRequest")).toMatchObject({
      retryOnFail: true,
      retries: 3,
      maxTries: 3,
    });
    expect(nodes.find((node) => node.name === "Set")).not.toHaveProperty("maxTries");
    expect(nodes.find((node) => node.name === "Set")).not.toHaveProperty("retries");
  });

  it("the mock transient-429 patch fixture validates and proposes the retry op", async () => {
    const llm = new MockLLM(envFor("transient-429"));
    const patch = (await llm.submit_verdict("patch", {}, patchVerdictSchema)) as unknown as {
      ops: Array<Record<string, unknown>>;
    };
    expect(validate(patchVerdictSchema, patch).ok).toBe(true);
    expect(patch.ops).toHaveLength(1);
    expect(patch.ops[0]).toMatchObject({ op: "set_retry", nodeId: "HttpRequest", retryOnFail: true });
    expect(patch.ops[0]?.retries as number).toBeGreaterThanOrEqual(1);
  });

  it("the mock transient-429 judge fixture validates as an approving verdict", async () => {
    const llm = new MockLLM(envFor("transient-429"));
    const judge = (await llm.submit_verdict("judge", {}, judgeVerdictSchema)) as unknown as {
      verdict: string;
      confidence: number;
    };
    expect(validate(judgeVerdictSchema, judge).ok).toBe(true);
    expect(judge.verdict).toBe("approve");
    expect(judge.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("the transient patch op target stays inside the diagnose affectedNodes scope", async () => {
    const llm = new MockLLM(envFor("transient-429"));
    const diagnose = (await llm.submit_verdict("diagnose", {}, diagnoseVerdictSchema)) as unknown as {
      affectedNodes: string[];
    };
    const patch = (await llm.submit_verdict("patch", {}, patchVerdictSchema)) as unknown as {
      ops: Array<{ nodeId?: string }>;
    };
    expect(validate(diagnoseVerdictSchema, diagnose).ok).toBe(true);
    for (const op of patch.ops) {
      expect(diagnose.affectedNodes).toContain(op.nodeId);
    }
  });
});
