/**
 * Focused unit probes for issue #26 (human broke the Code node).
 *
 * Covers the three seams the E2E exercises end to end: the mock
 * `human-broke-it` fixture stays Code-scoped with an approve-tier judge,
 * the store baseline lookup prefers the latest baseline (else the earliest
 * same-workflow snapshot, else null), and the orchestrator parks a durable
 * restore-from-baseline proposal that a fresh instance (empty in-memory
 * cache) can still approve.
 */

import { describe, expect, it } from "vitest";
import { openStore } from "../src/store/store.js";
import { MockLLM } from "../src/llm/mock.js";
import {
  diagnoseVerdictSchema,
  judgeVerdictSchema,
  patchVerdictSchema,
} from "../src/llm/schemas.js";
import { classifyTier } from "../src/pipeline/tier.js";
import { createOrchestrator, toTierInput } from "../src/orchestrator/orchestrator.js";

const SCENARIO_ENV = { MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv;

function seedWorkflow() {
  return {
    id: "wf-code",
    name: "code-flow",
    nodes: [
      {
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [0, 0],
        parameters: { value: "={{ $json.old }}" },
      },
      {
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [220, 0],
        parameters: { jsCode: "return items;" },
      },
    ],
    connections: {},
  };
}

function seedPayload(workflowId: string) {
  return {
    workflowId,
    data: { resultData: { runData: { Code: [{ error: { message: "boom" } }] } } },
  };
}

describe("mock human-broke-it fixture", () => {
  it("diagnoses a Code-node breakage whose judge classifies to tier approve", async () => {
    const llm = new MockLLM(SCENARIO_ENV);
    const diagnose = (await llm.submit_verdict("diagnose", {}, diagnoseVerdictSchema)) as {
      rootCauseKind: string;
      affectedNodes: string[];
    };
    expect(diagnose.rootCauseKind).toBe("human-broke-it");
    expect(diagnose.affectedNodes).toEqual(["Code"]);
    const patch = (await llm.submit_verdict("patch", {}, patchVerdictSchema)) as {
      ops: Array<{ path: string }>;
    };
    expect(patch.ops.length).toBeGreaterThan(0);
    expect(patch.ops.every((op) => op.path.startsWith("nodes.Code"))).toBe(true);
    const judge = (await llm.submit_verdict("judge", {}, judgeVerdictSchema)) as {
      verdict: string;
      confidence: number;
    };
    expect(judge.verdict).toBe("escalate");
    expect(judge.confidence).toBeGreaterThanOrEqual(0.8);
    expect(classifyTier(toTierInput(judge, { ok: true, failures: [] }))).toBe("approve");
  });
});

describe("store findBaselineSnapshot", () => {
  it("prefers the latest baseline, falls back to the earliest snapshot, else null", () => {
    const store = openStore(":memory:");
    try {
      store.insertSnapshot({
        id: "e-old:baseline",
        eventId: "e-old",
        kind: "baseline",
        workflowId: "wf-code",
        snapshot: { version: 1 },
      });
      store.insertSnapshot({
        id: "e-new:baseline",
        eventId: "e-new",
        kind: "baseline",
        workflowId: "wf-code",
        snapshot: { version: 2 },
      });
      expect(store.findBaselineSnapshot("wf-code")?.snapshot).toEqual({ version: 2 });

      store.insertSnapshot({
        id: "e-pre:pre-repair",
        eventId: "e-pre",
        kind: "pre-repair",
        workflowId: "wf-other",
        snapshot: { version: 9 },
      });
      expect(store.findBaselineSnapshot("wf-other")?.kind).toBe("pre-repair");
      expect(store.findBaselineSnapshot("wf-missing")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("orchestrator human-broke-it park and approve", () => {
  it("parks the baseline restore durably; a fresh instance approves it from the proposed snapshot", async () => {
    const store = openStore(":memory:");
    try {
      const baseline = seedWorkflow();
      const broken = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
      const code = (broken.nodes as Array<Record<string, unknown>>).find(
        (node) => node.name === "Code",
      );
      (code?.parameters as Record<string, unknown>).jsCode = "broken {{{";
      const llm = new MockLLM(SCENARIO_ENV);

      const first = createOrchestrator({
        store,
        llm,
        workflows: new Map<string, unknown>([["wf-code", broken]]),
      });
      store.insertSnapshot({
        id: "e-code:baseline",
        eventId: "e-code",
        kind: "baseline",
        workflowId: "wf-code",
        snapshot: baseline,
      });
      store.insertEvent({ executionId: "e-code", payload: seedPayload("wf-code") });
      store.updateEventStatus("e-code", "pending");

      const parked = await first.runRepairTurn("e-code");
      expect(parked).toMatchObject({ status: "awaiting-approval", tier: "approve" });
      expect(store.getEvent("e-code")?.status).toBe("awaiting-approval");
      const proposed = store.getSnapshot("e-code:proposed");
      expect(proposed?.kind).toBe("proposed");
      expect(proposed?.snapshot).toEqual(baseline);

      // Fresh instance: empty in-memory cache, live workflow still broken.
      const liveMap = new Map<string, unknown>([["wf-code", broken]]);
      const second = createOrchestrator({ store, llm, workflows: liveMap });
      const approved = await second.approve("e-code");
      expect(approved.status).toBe("promoted");
      expect(store.getEvent("e-code")?.status).toBe("promoted");
      expect(liveMap.get("wf-code")).toEqual(baseline);
    } finally {
      store.close();
    }
  });
});
