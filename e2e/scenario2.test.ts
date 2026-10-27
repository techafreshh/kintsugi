/**
 * E2E scenario 2 (issue #25): transient 429 with retry/backoff auto-promote.
 *
 * In-process end-to-end of the transient repair loop, no docker, no real n8n,
 * no network, no timers: a scripted `FakeN8nClient` (structural stand-in for
 * the real client) is seeded with the demo workflow plus a failing execution
 * whose runData carries the captured upstream payload. The fake models the
 * mock-upstream chaos window (`fail_next:3, fail_status:429`): its
 * `runWorkflow` throws a 429-flagged error while its internal countdown is
 * positive and returns the captured rows once the countdown exhausts,
 * recording every call. The real `MockLLM` runs the `transient-429`
 * scenario (retry/backoff patch proposal + approving judge) and the real
 * `runSandbox` harness + `verify` verifier replay the captured payload with
 * a countdown-aware retry loop. `POST /error-hook` registers the event, then
 * the real worker sweep (`runOnce` → `runRepairTurn`) drives view →
 * diagnose → patch → sandbox verify (fail-then-pass) → tier `auto` →
 * promoted, all synchronously.
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

const EXECUTION_ID = "exec-scenario-2";
const WORKFLOW_ID = "wf-demo";

/** Chaos window: three failed replays, then the upstream recovers. */
const FAIL_NEXT = 3;
const FAIL_STATUS = 429;

/** Retry budget: enough headroom to exhaust the chaos window, no sleeping. */
const MAX_ATTEMPTS = 6;

/** Captured upstream rows the sandbox replay must reproduce. */
const CAPTURED_ROWS = [
  { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
  { id: 2, name: "Alan Turing", email: "alan@example.com" },
];

/** Demo chain with the exact `HttpRequest` name the transient diagnose scope pins. */
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
        name: "HttpRequest",
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
        parameters: {},
      },
    ],
    connections: {
      Webhook: { main: [[{ node: "HttpRequest", type: "main", index: 0 }]] },
      HttpRequest: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      Set: { main: [[{ node: "Code", type: "main", index: 0 }]] },
    },
  };
}

/** Failing execution: the HttpRequest node errored with a 429 from upstream. */
function seedFailingExecution(): Record<string, unknown> {
  return {
    execution: {
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      status: "error",
      error: { message: `Request failed with status code ${FAIL_STATUS}` },
      lastNodeExecuted: "HttpRequest",
    },
    workflow: { id: WORKFLOW_ID },
    data: {
      resultData: {
        runData: {
          Webhook: [{ data: { main: [[{ json: CAPTURED_ROWS[0] }]] } }],
          HttpRequest: [
            {
              data: {
                main: [[{ json: CAPTURED_ROWS[0] }, { json: CAPTURED_ROWS[1] }]],
              },
              error: { message: `Request failed with status code ${FAIL_STATUS}` },
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
 * Rows the HttpRequest node captured from upstream before the 429: the
 * payload the sandbox replay must reproduce once the window exhausts.
 */
function capturedRows(payload: unknown): unknown[] {
  const runData = findRunData(payload);
  if (runData === null) return [];
  const tasks = runData["HttpRequest"] ?? runData["Webhook"] ?? runData["Set"];
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
  ok: boolean;
}

/**
 * Scripted stand-in for `N8nClient` with a chaos countdown: seeded with the
 * demo workflow, serves the failing execution, and replays the captured
 * payload rows through `runWorkflow` — throwing a 429-flagged error while
 * the `fail_next` countdown is positive, returning the rows once it
 * exhausts. Every call is recorded.
 */
class FakeN8nClient {
  private readonly workflows = new Map<string, unknown>();
  readonly updateCalls: UpdateCall[] = [];
  readonly runCalls: RunCall[] = [];
  private failNext: number;
  private nextSandboxId = 1;

  constructor(seed: Array<{ id: string; workflow: unknown }>, failNext: number) {
    for (const entry of seed) this.workflows.set(entry.id, deepClone(entry.workflow));
    this.failNext = failNext;
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
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.runCalls.push({ sandboxId, ok: false });
      const error = new Error(`Request failed with status code ${FAIL_STATUS}`) as Error & {
        statusCode: number;
      };
      error.statusCode = FAIL_STATUS;
      throw error;
    }
    this.runCalls.push({ sandboxId, ok: true });
    return { data: deepClone(capturedRows(payload)) };
  }

  async getExecution(id: string): Promise<Record<string, unknown>> {
    if (id !== EXECUTION_ID) throw new Error(`fake n8n: execution "${id}" not found`);
    return deepClone(seedFailingExecution());
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

describe("e2e scenario 2: transient 429, retry/backoff patch, auto-promote", () => {
  it("POST /error-hook → worker turn → fail-then-pass replay → promoted with retryOnFail + maxTries", async () => {
    store = openStore(":memory:");
    const active: Store = store;
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "transient-429" } as NodeJS.ProcessEnv);
    const seeded = seedWorkflow();
    const fake = new FakeN8nClient([{ id: WORKFLOW_ID, workflow: seeded }], FAIL_NEXT);

    // Countdown-aware retry loop: each attempt replays the captured payload
    // through the real `runSandbox` harness, folds the rows through the real
    // `verify` verifier, and audits one structured `sandbox` decision row
    // (fail while the chaos countdown is positive, pass once it exhausts).
    const verifyFn: VerifyFn = async (input) => {
      const captured = capturedRows(input.runData);
      const expectations = deriveExpectations({ rows: captured });
      let last: { ok: boolean; failures: unknown[] } = {
        ok: false,
        failures: [{ message: "verification budget exhausted without a green replay" }],
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const sandboxResult = await runSandbox({
          workflowId: input.workflowId,
          snapshot: input.patched,
          needleId: input.eventId,
          client: fake,
          triggerPayload: input.runData,
        });
        const rows = Array.isArray(sandboxResult.rows) ? sandboxResult.rows : [];
        const verdict = verify({ rows }, expectations);
        const ok = verdict.ok && sandboxResult.error === undefined;
        active.insertDecision({
          eventId: input.eventId,
          stage: "sandbox",
          verdict: ok ? "pass" : "fail",
          reason: JSON.stringify({
            attempt,
            strategy: sandboxResult.strategy,
            ...(ok ? { rowCount: rows.length } : { error: sandboxResult.error ?? "replay failed" }),
            provenance: `failing-execution:${input.eventId}`,
            sandboxWorkflowId: sandboxResult.sandboxWorkflowId,
          }),
          confidence: ok ? 1 : 0,
        });
        if (ok) return { ok: true, failures: [] };
        last = {
          ok: false,
          failures:
            verdict.failures.length > 0
              ? verdict.failures
              : [{ message: sandboxResult.error ?? "replay failed" }],
        };
      }
      return last;
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

    // Drive the real worker sweep (the same `runRepairTurn` path the
    // interval poller calls): view → diagnose → patch → sandbox verify →
    // tier.
    const swept = await runOnce(orchestrator, active);
    expect(swept).toMatchObject({ processed: 1, failed: 0 });

    // Acceptance 1: the event reaches promoted.
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

    // Acceptance 2: one promotion write whose HttpRequest node carries
    // retryOnFail plus maxTries, with every other node byte-identical.
    expect(fake.updateCalls).toHaveLength(1);
    const promoted = fake.updateCalls[0]?.workflow;
    expect(fake.updateCalls[0]?.id).toBe(WORKFLOW_ID);
    const httpNode = nodeByName(promoted, "HttpRequest") as Record<string, unknown> | undefined;
    expect(httpNode).toBeDefined();
    expect(httpNode?.retryOnFail).toBe(true);
    expect(httpNode?.maxTries as number).toBeGreaterThanOrEqual(1);
    const diff = diffWorkflows(seeded, promoted);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.length).toBeGreaterThanOrEqual(1);
    expect(diff.changed.every((entry) => entry.name === "HttpRequest")).toBe(true);
    for (const name of ["Webhook", "Set", "Code"]) {
      expect(nodeByName(promoted, name)).toEqual(nodeByName(seeded, name));
    }

    // Acceptance 3: the verification log shows failed attempts while the
    // countdown was positive, followed by a passed attempt, in order.
    expect(fake.runCalls.length).toBeGreaterThanOrEqual(FAIL_NEXT + 1);
    expect(fake.runCalls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(fake.runCalls.slice(0, FAIL_NEXT).every((call) => call.ok === false)).toBe(true);
    expect(fake.runCalls[fake.runCalls.length - 1]?.ok).toBe(true);
    expect(detail.verification.ok).toBe(true);
    expect(detail.verification.strategy).toBe("run-endpoint");
    expect(detail.verification.rowCount).toBe(CAPTURED_ROWS.length);
    expect(detail.verification.provenance).toContain(EXECUTION_ID);
    const decisions = active.listDecisions(EXECUTION_ID);
    expect(
      decisions.some((row) => row.stage === "outcome" && row.verdict === "promoted"),
    ).toBe(true);
    expect(
      decisions.some((row) => row.stage === "tier" && row.verdict === "auto-promote"),
    ).toBe(true);
    const sandboxRows = decisions.filter((row) => row.stage === "sandbox");
    expect(sandboxRows.length).toBeGreaterThanOrEqual(FAIL_NEXT + 1);
    const verdicts = sandboxRows.map((row) => row.verdict);
    const firstFail = verdicts.indexOf("fail");
    const firstPass = verdicts.indexOf("pass");
    expect(firstFail).toBeGreaterThanOrEqual(0);
    expect(firstPass).toBeGreaterThan(firstFail);
    expect(verdicts.slice(0, firstPass).every((verdict) => verdict === "fail")).toBe(true);
    const attempts = sandboxRows.map(
      (row) => (JSON.parse(row.reason) as { attempt: number }).attempt,
    );
    expect(attempts).toEqual([...attempts].sort((a, b) => a - b));
    const logged = JSON.parse(sandboxRows[firstPass]?.reason ?? "{}") as {
      rowCount: number;
      strategy: string;
    };
    expect(logged.strategy).toBe("run-endpoint");
    expect(logged.rowCount).toBe(CAPTURED_ROWS.length);

    // Acceptance 4: the LLM audit trail carries mock-mode traces.
    const traces = active.listTraces(EXECUTION_ID);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((trace) => trace.llmMode === "mock")).toBe(true);
  });
});
