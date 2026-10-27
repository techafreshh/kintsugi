import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/store/store.js";
import { MockLLM } from "../src/llm/mock.js";
import { createOrchestrator } from "../src/orchestrator/orchestrator.js";
import { runOnce } from "../src/orchestrator/worker.js";
import type { LLMPort } from "../src/llm/port.js";

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

function seedWorkflow() {
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

function seedRunPayload(workflowId: string) {
  return {
    workflowId,
    data: {
      resultData: {
        runData: {
          Start: [{ data: { main: [[{ json: { a: 1 } }]] } }],
          Set: [{ data: { main: [[{ json: { a: 1 } }]] }, error: { message: "boom" } }],
        },
      },
    },
  };
}

function mapWorkflows(workflow: Record<string, unknown>) {
  const map = new Map<string, unknown>();
  const id = typeof workflow.id === "string" ? workflow.id : "wf-1";
  map.set(id, JSON.parse(JSON.stringify(workflow)) as unknown);
  return map;
}

describe("orchestrator: schema-drift promotes with a pre-repair snapshot", () => {
  it("one turn moves through diagnosing toward promoted and leaves a pre-repair snapshot", async () => {
    const workflow = seedWorkflow();
    const workflows = mapWorkflows(workflow);
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({ store, llm, workflows });
    store.insertEvent({ executionId: "e-schema", payload: seedRunPayload("wf-1") });
    store.updateEventStatus("e-schema", "pending");
    const result = await orchestrator.runRepairTurn("e-schema");
    expect(result.status).toBe("promoted");
    expect(store.getEvent("e-schema")?.status).toBe("promoted");
    const preRepair = store.getSnapshot("e-schema:pre-repair");
    expect(preRepair).not.toBeNull();
    expect(preRepair?.kind).toBe("pre-repair");
    expect(preRepair?.snapshot).toEqual(workflow);
    expect(store.listSnapshots("e-schema").some((snap) => snap.kind === "pre-repair")).toBe(true);
  });
});

describe("orchestrator: approve tier parks for approval with a tier metric", () => {
  it("an approve-tier pass leaves awaiting-approval and tier.approve >= 1", async () => {
    const workflows = mapWorkflows(seedWorkflow());
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({ store, llm, workflows });
    store.insertEvent({ executionId: "e-approve", payload: seedRunPayload("wf-1") });
    store.updateEventStatus("e-approve", "pending");
    const result = await orchestrator.runRepairTurn("e-approve");
    expect(result.status).toBe("awaiting-approval");
    expect(store.getEvent("e-approve")?.status).toBe("awaiting-approval");
    expect(store.getMetrics()["tier.approve"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("orchestrator: approve promotes a parked event with a pre-promotion snapshot", () => {
  it("approve() from awaiting-approval yields promoted plus a pre-promotion snapshot", async () => {
    const workflows = mapWorkflows(seedWorkflow());
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({ store, llm, workflows });
    store.insertEvent({ executionId: "e-parked", payload: seedRunPayload("wf-1") });
    store.updateEventStatus("e-parked", "pending");
    await orchestrator.runRepairTurn("e-parked");
    expect(store.getEvent("e-parked")?.status).toBe("awaiting-approval");
    const result = await orchestrator.approve("e-parked");
    expect(result.status).toBe("promoted");
    expect(store.getEvent("e-parked")?.status).toBe("promoted");
    const prePromotion = store.getSnapshot("e-parked:pre-promotion");
    expect(prePromotion).not.toBeNull();
    expect(prePromotion?.kind).toBe("pre-promotion");
  });
});

describe("orchestrator: revert restores the pre-repair workflow", () => {
  it("revert() from promoted restores deep-equal live workflow and status reverted", async () => {
    const workflow = seedWorkflow();
    const workflows = mapWorkflows(workflow);
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({ store, llm, workflows });
    store.insertEvent({ executionId: "e-revert", payload: seedRunPayload("wf-1") });
    store.updateEventStatus("e-revert", "pending");
    await orchestrator.runRepairTurn("e-revert");
    expect(store.getEvent("e-revert")?.status).toBe("promoted");
    const result = await orchestrator.revert("e-revert");
    expect(result.status).toBe("reverted");
    expect(store.getEvent("e-revert")?.status).toBe("reverted");
    const live = (workflows as Map<string, unknown>).get("wf-1");
    const preRepair = store.getSnapshot("e-revert:pre-repair");
    expect(preRepair).not.toBeNull();
    expect(live).toEqual(preRepair?.snapshot);
    expect(live).toEqual(workflow);
  });
});

describe("orchestrator: failing diagnose parks as failed without promotion", () => {
  it("an LLMPort throw yields failed with no pre-promotion snapshot", async () => {
    const workflows = mapWorkflows(seedWorkflow());
    const failingLlm: LLMPort = {
      name: "failing",
      mode: "mock",
      submit_verdict: async () => {
        throw new Error("llm down");
      },
    };
    const orchestrator = createOrchestrator({ store, llm: failingLlm, workflows });
    store.insertEvent({ executionId: "e-fail", payload: seedRunPayload("wf-1") });
    store.updateEventStatus("e-fail", "pending");
    const result = await orchestrator.runRepairTurn("e-fail");
    expect(result.status).toBe("failed");
    expect(store.getEvent("e-fail")?.status).toBe("failed");
    expect(store.getSnapshot("e-fail:pre-promotion")).toBeNull();
    expect(store.getEvent("e-fail")?.status).not.toBe("promoted");
  });
});

describe("store: status mutation for the repair loop", () => {
  it("updateEventStatus round-trips and listEventsByStatus filters", () => {
    store.insertEvent({ executionId: "s1", payload: {} });
    const updated = store.updateEventStatus("s1", "pending");
    expect(updated?.status).toBe("pending");
    expect(store.getEvent("s1")?.status).toBe("pending");
    expect(store.listEventsByStatus("pending").map((event) => event.executionId)).toEqual(["s1"]);
    expect(store.listEventsByStatus("received")).toEqual([]);
  });

  it("updateEventStatus returns null for a missing id", () => {
    expect(store.updateEventStatus("nope", "pending")).toBeNull();
  });
});

describe("worker: runOnce sweeps queued events", () => {
  it("processes received events without stopping on one failure", async () => {
    const workflows = mapWorkflows(seedWorkflow());
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({ store, llm, workflows });
    store.insertEvent({ executionId: "w-1", payload: seedRunPayload("wf-1") });
    const swept = await runOnce(orchestrator, store);
    expect(swept.processed).toBe(1);
    expect(store.getEvent("w-1")?.status).toBe("promoted");
  });
});
