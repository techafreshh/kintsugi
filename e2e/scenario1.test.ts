/**
 * E2E scenario 1 (issue #24): schema drift, Set-only patch, auto-promote.
 *
 * In-process end-to-end of the primary repair loop, no docker, no real n8n,
 * no network, no timers: a scripted `FakeN8nClient` (structural stand-in for
 * the real client) is seeded with the demo workflow plus a failing execution
 * whose runData carries the drifted upstream schema (`name`/`email`/`city`
 * where the Set node still maps `full_name`/`contact.email`/`address.city`).
 * The real `MockLLM` runs the `schema-drift` scenario and the real
 * `runSandbox` harness + `verify` verifier replay the captured payload
 * through the fake. `POST /error-hook` registers the event, then the real
 * worker sweep (`runOnce` → `runRepairTurn`) drives view → diagnose → patch
 * → sandbox verify → tier `auto` → promoted, all synchronously.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/receiver/app.js";
import { loadSettings } from "../src/config/settings.js";
import { MockLLM } from "../src/llm/mock.js";
import { diffWorkflows } from "../src/diff/workflowDiff.js";
import {
  createOrchestrator,
  type VerifyFn,
} from "../src/orchestrator/orchestrator.js";
import { runOnce } from "../src/orchestrator/worker.js";
import { runSandbox } from "../src/sandbox/harness.js";
import { deriveExpectations, verify } from "../src/sandbox/verify.js";
import { openStore, type Store } from "../src/store/store.js";

const EXECUTION_ID = "exec-scenario-1";
const WORKFLOW_ID = "wf-demo";

/** Drifted upstream rows: the new schema the Set node must learn to read. */
const NEW_SCHEMA_ROWS = [
  { name: "Ada Lovelace", email: "ada@example.com", city: "London" },
  { name: "Alan Turing", email: "alan@example.com", city: "Bletchley" },
];

/** Demo chaos chain (mirrors `buildDemoWorkflow`): Webhook → HTTP → Set → Code. */
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
        parameters: {
          full_name: "={{ $json.full_name }}",
          contact: { email: "={{ $json.contact.email }}" },
          address: { city: "={{ $json.address.city }}" },
        },
      },
      {
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [600, 0],
        parameters: {},
      },
    ],
    connections: {
      Webhook: { main: [[{ node: "HTTP Request", type: "main", index: 0 }]] },
      "HTTP Request": { main: [[{ node: "Set", type: "main", index: 0 }]] },
      Set: { main: [[{ node: "Code", type: "main", index: 0 }]] },
    },
  };
}

/** Failing execution: runData shows the upstream now serving the new schema. */
function seedFailingExecution(): Record<string, unknown> {
  return {
    execution: {
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      status: "error",
      error: { message: "Cannot read properties of undefined (reading 'full_name')" },
      lastNodeExecuted: "Set",
    },
    workflow: { id: WORKFLOW_ID },
    data: {
      resultData: {
        runData: {
          Webhook: [{ data: { main: [[{ json: NEW_SCHEMA_ROWS[0] }]] } }],
          "HTTP Request": [
            {
              data: {
                main: [[{ json: NEW_SCHEMA_ROWS[0] }, { json: NEW_SCHEMA_ROWS[1] }]],
              },
            },
          ],
          Set: [
            {
              data: { main: [[{ json: NEW_SCHEMA_ROWS[0] }]] },
              error: { message: "Cannot read properties of undefined (reading 'full_name')" },
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
 * Rows the Set node consumed from upstream: the HTTP node's captured output
 * inside the failing execution's runData. This is the "captured payload" the
 * sandbox replay must reproduce.
 */
function capturedRows(payload: unknown): unknown[] {
  const runData = findRunData(payload);
  if (runData === null) return [];
  const tasks = runData["HTTP Request"] ?? runData["HttpRequest"] ?? runData["Set"];
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
 * write for the Set-only assertion.
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
    // Stand-in for the mock-upstream chaos service in `schema=new` mode: the
    // replayed rows are exactly what the failing execution captured upstream.
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

describe("e2e scenario 1: schema drift, Set-only patch, auto-promote", () => {
  it("POST /error-hook → worker turn → promoted with tier auto and a green verified replay", async () => {
    store = openStore(":memory:");
    const active: Store = store;
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const seeded = seedWorkflow();
    const fake = new FakeN8nClient([{ id: WORKFLOW_ID, workflow: seeded }]);

    // Real verification: replay the captured payload through the fake via the
    // real `runSandbox` harness, fold the rows through the real `verify`
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

    const app = createApp({ store: active, settings: loadSettings() });
    const orchestrator = createOrchestrator({
      store: active,
      llm,
      workflows: fake,
      verifyFn,
      settings: loadSettings(),
    });

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

    // Drive the real worker sweep (same `runRepairTurn` path the interval
    // poller calls): view → diagnose → patch → sandbox verify → tier.
    const swept = await runOnce(orchestrator, active);
    expect(swept).toMatchObject({ processed: 1, failed: 0 });

    // Acceptance 1: the detail endpoint shows promoted + tier auto.
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
    expect(detail.tier).toBe("auto");

    // Acceptance 2: one promotion write whose Set mappings read the new
    // schema fields, with every other node byte-identical.
    expect(fake.updateCalls).toHaveLength(1);
    const promoted = fake.updateCalls[0]?.workflow;
    expect(fake.updateCalls[0]?.id).toBe(WORKFLOW_ID);
    const setNode = nodeByName(promoted, "Set") as Record<string, unknown> | undefined;
    expect(setNode).toBeDefined();
    const parameters = (setNode as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(parameters.name).toBe("={{ $json.name }}");
    expect(parameters.email).toBe("={{ $json.email }}");
    expect(parameters.city).toBe("={{ $json.city }}");
    const diff = diffWorkflows(seeded, promoted);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.changed.every((entry) => entry.name === "Set")).toBe(true);
    for (const name of ["Webhook", "HTTP Request", "Code"]) {
      expect(nodeByName(promoted, name)).toEqual(nodeByName(seeded, name));
    }

    // Acceptance 3: the verification log shows a green sandbox run whose
    // replayed rows came from the failing execution's captured payload.
    expect(fake.runCalls).toHaveLength(1);
    expect(fake.runCalls[0]?.rows).toEqual(NEW_SCHEMA_ROWS);
    expect(detail.verification.ok).toBe(true);
    expect(detail.verification.strategy).toBe("run-endpoint");
    expect(detail.verification.rowCount).toBe(NEW_SCHEMA_ROWS.length);
    expect(detail.verification.provenance).toContain(EXECUTION_ID);
    const decisions = active.listDecisions(EXECUTION_ID);
    expect(
      decisions.some((row) => row.stage === "outcome" && row.verdict === "promoted"),
    ).toBe(true);
    expect(
      decisions.some((row) => row.stage === "tier" && row.verdict === "auto-promote"),
    ).toBe(true);
    const sandboxRows = decisions.filter((row) => row.stage === "sandbox");
    expect(sandboxRows.length).toBeGreaterThanOrEqual(1);
    const logged = JSON.parse(sandboxRows[0]?.reason ?? "{}") as {
      rowCount: number;
      strategy: string;
    };
    expect(logged.strategy).toBe("run-endpoint");
    expect(logged.rowCount).toBe(NEW_SCHEMA_ROWS.length);

    // Acceptance 4: the LLM audit trail carries mock-mode traces.
    const traces = active.listTraces(EXECUTION_ID);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((trace) => trace.llmMode === "mock")).toBe(true);
  });
});
