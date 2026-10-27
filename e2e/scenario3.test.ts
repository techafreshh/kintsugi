/**
 * E2E scenario 3 (issue #26): human broke the Code node, approval path.
 *
 * In-process end-to-end of the restore-from-baseline approval loop, no
 * docker, no real n8n, no network, no timers: a scripted `FakeN8nClient`
 * (structural stand-in for the real client) is seeded with the demo
 * workflow plus a failing execution whose runData carries the Code node's
 * validation error. The baseline snapshot is registered before the fixture
 * mutates the fake's Code node (the human hand edit); the real `MockLLM`
 * runs the `human-broke-it` scenario and the real `runSandbox` harness +
 * `verify` verifier replay the captured payload through the fake.
 * `POST /error-hook` registers the event, then the real worker sweep
 * (`runOnce` → `runRepairTurn`) drives view → diagnose → restore-from-
 * baseline → sandbox verify → judge → tier `approve` → parked in
 * `awaiting_approval`, and the token-gated approve endpoint promotes the
 * restore so the live Code node is byte-equal to the baseline.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/receiver/app.js";
import { loadSettings } from "../src/config/settings.js";
import { MockLLM } from "../src/llm/mock.js";
import {
  createOrchestrator,
  type VerifyFn,
} from "../src/orchestrator/orchestrator.js";
import { runOnce } from "../src/orchestrator/worker.js";
import { runSandbox } from "../src/sandbox/harness.js";
import { deriveExpectations, verify } from "../src/sandbox/verify.js";
import { openStore, type Store } from "../src/store/store.js";

const EXECUTION_ID = "exec-scenario-3";
const WORKFLOW_ID = "wf-demo";
const DASHBOARD_TOKEN = "test-token";

/** Captured upstream rows the sandbox replay must reproduce. */
const CAPTURED_ROWS = [
  { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
  { id: 2, name: "Alan Turing", email: "alan@example.com" },
];

/** Baseline Code validator: the script the human hand edit will break. */
const BASELINE_JS = "return items.map((item) => ({ json: item.json }));";

/** Demo chain (mirrors `buildDemoWorkflow`): Webhook → HTTP Request → Set → Code. */
function seedWorkflow(): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: "kintsugi-demo-chaos",
    nodes: [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: "kintsugi-demo", httpMethod: "POST" },
      },
      {
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [200, 0],
        parameters: { url: "http://localhost:3001/api/users", method: "GET" },
      },
      {
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [400, 0],
        parameters: { id: "={{ $json.id }}", name: "={{ $json.name }}" },
      },
      {
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [600, 0],
        parameters: { jsCode: BASELINE_JS, mode: "runOnceForAllItems" },
      },
    ],
    connections: {
      Webhook: { main: [[{ node: "HTTP Request", type: "main", index: 0 }]] },
      "HTTP Request": { main: [[{ node: "Set", type: "main", index: 0 }]] },
      Set: { main: [[{ node: "Code", type: "main", index: 0 }]] },
    },
  };
}

/** Failing execution: the Code node errored after the human hand edit. */
function seedFailingExecution(): Record<string, unknown> {
  return {
    execution: {
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      status: "error",
      error: { message: "Code node failed: Unexpected token '}'" },
      lastNodeExecuted: "Code",
    },
    workflow: { id: WORKFLOW_ID },
    data: {
      resultData: {
        runData: {
          Webhook: [{ data: { main: [[{ json: CAPTURED_ROWS[0] }]] } }],
          "HTTP Request": [
            {
              data: {
                main: [[{ json: CAPTURED_ROWS[0] }, { json: CAPTURED_ROWS[1] }]],
              },
            },
          ],
          Code: [
            {
              data: { main: [[{ json: CAPTURED_ROWS[0] }]] },
              error: { message: "Code node failed: Unexpected token '}'" },
            },
          ],
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Locate the n8n run-data map inside any execution-ish container. */
function findRunData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.data) && isRecord(payload.data.resultData)) {
    const runData = (payload.data.resultData as Record<string, unknown>).runData;
    if (isRecord(runData)) return runData;
  }
  if (isRecord(payload.resultData) && isRecord(payload.resultData.runData)) {
    return payload.resultData.runData as Record<string, unknown>;
  }
  if (isRecord(payload.runData)) return payload.runData as Record<string, unknown>;
  return null;
}

/**
 * Rows the HTTP node captured from upstream: the payload the sandbox replay
 * must reproduce when verifying the restored baseline.
 */
function capturedRows(payload: unknown): unknown[] {
  const runData = findRunData(payload);
  if (runData === null) return [];
  const tasks = runData["HTTP Request"] ?? runData["Webhook"] ?? runData["Set"];
  if (!Array.isArray(tasks)) return [];
  const rows: unknown[] = [];
  for (const task of tasks) {
    if (!isRecord(task) || !isRecord(task.data)) continue;
    const mains = (task.data as Record<string, unknown>).main;
    if (!Array.isArray(mains)) continue;
    for (const output of mains) {
      if (!Array.isArray(output)) continue;
      for (const item of output) {
        if (isRecord(item) && item.json !== undefined) rows.push(item.json);
      }
    }
  }
  return rows;
}

interface UpdateCall {
  id: string;
  workflow: unknown;
}

interface RunCall {
  sandboxId: string;
  rows: unknown[];
}

/**
 * Scripted stand-in for `N8nClient`: seeded with the demo workflow, serves
 * the failing execution, replays the captured payload rows through
 * `runWorkflow`, and records every `putWorkflow`/`updateWorkflow` promotion
 * write for the restore assertion.
 */
class FakeN8nClient {
  private readonly workflows = new Map<string, unknown>();
  readonly updateCalls: UpdateCall[] = [];
  readonly runCalls: RunCall[] = [];
  private nextSandboxId = 1;

  constructor(seed: Array<{ id: string; workflow: unknown }>) {
    for (const entry of seed) this.workflows.set(entry.id, deepClone(entry.workflow));
  }

  async getWorkflow(id: string): Promise<Record<string, unknown>> {
    const found = this.workflows.get(id);
    if (found === undefined || !isRecord(found)) {
      throw new Error(`fake n8n: workflow "${id}" not found`);
    }
    return deepClone(found);
  }

  async putWorkflow(id: string, workflow: unknown): Promise<Record<string, unknown>> {
    const stored: Record<string, unknown> = deepClone(workflow) as Record<string, unknown>;
    this.updateCalls.push({ id, workflow: stored });
    this.workflows.set(id, stored);
    return deepClone(stored);
  }

  async updateWorkflow(id: string, workflow: unknown): Promise<Record<string, unknown>> {
    return this.putWorkflow(id, workflow);
  }

  async createWorkflow(json: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `sandbox-${this.nextSandboxId++}`;
    const created = { ...deepClone(json), id };
    this.workflows.set(id, created);
    return deepClone(created);
  }

  async deleteWorkflow(id: string): Promise<Record<string, unknown>> {
    const found = this.workflows.get(id);
    this.workflows.delete(id);
    return isRecord(found) ? deepClone(found) : {};
  }

  async probeRunEndpoint(_id: string): Promise<boolean> {
    return true;
  }

  async runWorkflow(sandboxId: string, payload: unknown): Promise<unknown> {
    // Stand-in for the mock-upstream chaos service: the replayed rows are
    // exactly what the failing execution captured upstream.
    const rows = capturedRows(payload);
    this.runCalls.push({ sandboxId, rows });
    return { data: deepClone(rows) };
  }

  async getExecution(id: string): Promise<Record<string, unknown>> {
    if (id !== EXECUTION_ID) throw new Error(`fake n8n: execution "${id}" not found`);
    return deepClone(seedFailingExecution());
  }

  live(id: string): unknown {
    return this.workflows.get(id);
  }

  /** The human hand edit: break the Code node's validator in place. */
  breakCodeNode(id: string): void {
    const found = this.workflows.get(id);
    if (!isRecord(found) || !Array.isArray(found.nodes)) {
      throw new Error(`fake n8n: workflow "${id}" has no node list to break`);
    }
    const code = (found.nodes as unknown[]).find(
      (node) => isRecord(node) && node.name === "Code",
    );
    if (!isRecord(code) || !isRecord(code.parameters)) {
      throw new Error(`fake n8n: workflow "${id}" has no Code node to break`);
    }
    code.parameters.jsCode = "return items.map((item) => ({ json: item.json }";
  }
}

function nodeByName(workflow: unknown, name: string): unknown {
  if (!isRecord(workflow) || !Array.isArray(workflow.nodes)) return undefined;
  return (workflow.nodes as unknown[]).find(
    (node) => isRecord(node) && node.name === name,
  );
}

let store: Store | null = null;

afterEach(() => {
  try {
    store?.close();
  } catch {
    // Close is best-effort; the assertions already ran.
  }
  store = null;
});

describe("e2e scenario 3: human broke the Code node, approval path", () => {
  it("POST /error-hook → worker parks the restore → token-gated approve promotes the byte-equal Code node", async () => {
    store = openStore(":memory:");
    const active: Store = store;
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv);
    const seeded = seedWorkflow();
    const fake = new FakeN8nClient([{ id: WORKFLOW_ID, workflow: seeded }]);

    // Baseline snapshot of the pre-edit workflow, then the human hand edit
    // breaks the fake's Code node validator.
    active.insertSnapshot({
      id: `${EXECUTION_ID}:baseline`,
      eventId: EXECUTION_ID,
      kind: "baseline",
      workflowId: WORKFLOW_ID,
      snapshot: deepClone(seeded),
    });
    fake.breakCodeNode(WORKFLOW_ID);
    const baselineCode = JSON.stringify(nodeByName(seeded, "Code"));
    expect(JSON.stringify(nodeByName(fake.live(WORKFLOW_ID), "Code"))).not.toBe(baselineCode);

    // Real verification: replay the captured payload through the fake via
    // the real `runSandbox` harness, fold the rows through the real `verify`
    // verifier, and audit the green run as a structured decision row.
    const verifyFn: VerifyFn = async (input) => {
      const sandboxResult = await runSandbox({
        workflowId: input.workflowId,
        snapshot: input.patched,
        needleId: input.eventId,
        client: fake,
        triggerPayload: input.runData,
      });
      const rows = Array.isArray(sandboxResult.rows) ? sandboxResult.rows : [];
      const captured = capturedRows(input.runData);
      const verdict = verify({ rows }, deriveExpectations({ rows: captured }));
      active.insertDecision({
        eventId: input.eventId,
        stage: "sandbox",
        verdict: sandboxResult.strategy,
        reason: JSON.stringify({
          strategy: sandboxResult.strategy,
          rowCount: rows.length,
          provenance: `failing-execution:${input.eventId}`,
          sandboxWorkflowId: sandboxResult.sandboxWorkflowId,
        }),
        confidence: verdict.ok ? 1 : 0,
      });
      return {
        ok: verdict.ok && sandboxResult.error === undefined,
        failures: verdict.failures,
      };
    };

    const settings = { ...loadSettings(), dashboardToken: DASHBOARD_TOKEN };
    const orchestrator = createOrchestrator({
      store: active,
      llm,
      workflows: fake,
      verifyFn,
      settings,
    });
    // One shared orchestrator: the worker parks the restore through it and
    // the dashboard approve route promotes through it.
    const app = createApp({ store: active, settings, orchestrator });

    // Register the failing execution over HTTP, exactly like the n8n Error
    // Trigger forwarder would.
    const postRes = await app.request("/error-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seedFailingExecution()),
    });
    expect(postRes.status).toBe(200);
    const posted = (await postRes.json()) as { ok: boolean; event_id: string; created: boolean };
    expect(posted).toMatchObject({ ok: true, event_id: EXECUTION_ID, created: true });

    // Drive the real worker sweep (the same `runRepairTurn` path the
    // interval poller calls): view → diagnose → restore-from-baseline →
    // sandbox verify → judge → tier `approve` → parked for approval.
    const swept = await runOnce(orchestrator, active);
    expect(swept).toMatchObject({ processed: 1, failed: 0 });

    // Acceptance 1: the detail endpoint shows awaiting_approval + approve.
    const parkedRes = await app.request(`/repair-events/${EXECUTION_ID}`);
    expect(parkedRes.status).toBe(200);
    const parked = (await parkedRes.json()) as {
      event_id: string;
      status: string;
      tier: string | null;
    };
    expect(parked.event_id).toBe(EXECUTION_ID);
    expect(parked.status).toBe("awaiting_approval");
    expect(parked.tier).toBe("approve");

    // The restore is parked durably, not only in the orchestrator's memory.
    const proposed = active.getSnapshot(`${EXECUTION_ID}:proposed`);
    expect(proposed).not.toBeNull();
    expect(proposed?.kind).toBe("proposed");
    expect(JSON.stringify(nodeByName(proposed?.snapshot, "Code"))).toBe(baselineCode);

    // Acceptance 2: the approve endpoint is token-gated.
    const denied = await app.request(`/repair-events/${EXECUTION_ID}/approve`, {
      method: "POST",
    });
    expect(denied.status).toBe(401);
    const allowed = await app.request(`/repair-events/${EXECUTION_ID}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DASHBOARD_TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      event_id: EXECUTION_ID,
      status: "promoted",
    });

    // Acceptance 3: after approval the fake's Code node is byte-equal to the
    // baseline snapshot's Code node, and the event is promoted.
    expect(fake.updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(nodeByName(fake.live(WORKFLOW_ID), "Code"))).toBe(baselineCode);
    expect(fake.live(WORKFLOW_ID)).toEqual(seeded);
    const detailRes = await app.request(`/repair-events/${EXECUTION_ID}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      event_id: string;
      status: string;
      tier: string | null;
      verification: {
        ok: boolean;
        strategy: string | null;
        rowCount: number | null;
        provenance: string | null;
      };
    };
    expect(detail.event_id).toBe(EXECUTION_ID);
    expect(detail.status).toBe("promoted");

    // The verification log shows the green replay of the captured payload.
    expect(fake.runCalls).toHaveLength(1);
    expect(fake.runCalls[0]?.rows).toEqual(CAPTURED_ROWS);
    expect(detail.verification.ok).toBe(true);
    expect(detail.verification.strategy).toBe("run-endpoint");
    expect(detail.verification.rowCount).toBe(CAPTURED_ROWS.length);
    expect(detail.verification.provenance).toContain(EXECUTION_ID);
    const decisions = active.listDecisions(EXECUTION_ID);
    expect(
      decisions.some((row) => row.stage === "outcome" && row.verdict === "promoted"),
    ).toBe(true);
    expect(decisions.some((row) => row.stage === "tier" && row.verdict === "approve")).toBe(
      true,
    );
    const sandboxRows = decisions.filter((row) => row.stage === "sandbox");
    expect(sandboxRows.length).toBeGreaterThanOrEqual(1);
    const logged = JSON.parse(sandboxRows[0]?.reason ?? "{}") as {
      rowCount: number;
      strategy: string;
    };
    expect(logged.strategy).toBe("run-endpoint");
    expect(logged.rowCount).toBe(CAPTURED_ROWS.length);

    // The LLM audit trail carries mock-mode traces.
    const traces = active.listTraces(EXECUTION_ID);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((trace) => trace.llmMode === "mock")).toBe(true);
  });
});
