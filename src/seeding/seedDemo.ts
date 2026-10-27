/**
 * Demo seeder (issue #21): installs the two demonstrable workflows into the
 * configured n8n — the demo chaos chain and the error-trigger forwarder —
 * then registers a `baseline` snapshot of the demo workflow in the store.
 * Pure dependency injection: the seeder takes `{ client, store, urls }` and
 * never reads `process.env`; the CLI wires real `N8nClient` + `openStore`
 * from `Settings`.
 */

import type { N8nClient, WorkflowJson } from "../n8n/client.js";
import type { Store } from "../store/store.js";

/** Exact n8n workflow names; idempotency matches on these only. */
export const DEMO_WORKFLOW_NAME = "kintsugi-demo-chaos";
export const ERROR_TRIGGER_WORKFLOW_NAME = "kintsugi-error-trigger";

/** Deterministic baseline snapshot identity. */
export const BASELINE_SNAPSHOT_ID = "seed-demo-baseline";
export const BASELINE_EVENT_ID = "seed-demo";

export interface SeedDemoOptions {
  client: N8nClient;
  store: Store;
  /** Mock-upstream root; the HTTP node calls `<base>/api/users`. */
  mockUpstreamUrl: string;
  /** Absolute Kintsugi `/error-hook` URL the error-trigger workflow posts to. */
  errorHookUrl: string;
}

export interface SeedDemoResult {
  demoWorkflowId: string;
  errorTriggerWorkflowId: string;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function nodeNamesOf(workflow: WorkflowJson): string[] {
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes)) return [];
  const names: string[] = [];
  for (const node of nodes) {
    if (typeof node === "object" && node !== null) {
      const name = (node as Record<string, unknown>).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/**
 * Walk the workflow's `connections` topology from `Webhook`, following the
 * first `main` output of each node. Falls back to array order when no
 * connections are present.
 */
export function connectionChainNames(workflow: WorkflowJson): string[] {
  const names = nodeNamesOf(workflow);
  const connections = workflow.connections;
  if (typeof connections !== "object" || connections === null || Array.isArray(connections)) {
    return names;
  }
  const table = connections as Record<string, unknown>;
  const start = "Webhook";
  if (!names.includes(start)) return names;
  const chain: string[] = [start];
  const seen = new Set<string>([start]);
  let current = start;
  for (let step = 0; step < names.length; step++) {
    const entry = table[current];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) break;
    const main = (entry as Record<string, unknown>).main;
    if (!Array.isArray(main)) break;
    let next: string | undefined;
    for (const output of main) {
      if (!Array.isArray(output)) continue;
      for (const edge of output) {
        if (typeof edge === "object" && edge !== null) {
          const target = (edge as Record<string, unknown>).node;
          if (typeof target === "string" && target !== "" && !seen.has(target)) {
            next = target;
            break;
          }
        }
      }
      if (next !== undefined) break;
    }
    if (next === undefined) break;
    chain.push(next);
    seen.add(next);
    current = next;
  }
  return chain.length > 1 ? chain : names;
}

function link(from: string, to: string): Record<string, unknown> {
  return { [from]: { main: [[{ node: to, type: "main", index: 0 }]] } };
}

/**
 * Demo chaos workflow: Webhook → HTTP Request (GET `<base>/api/users` on the
 * mock-upstream chaos service) → Set mapping → Code validator. The node array
 * and the `connections` chain both carry the exact order
 * `[Webhook, HTTP Request, Set, Code]`.
 */
export function buildDemoWorkflow(mockUpstreamUrl: string): WorkflowJson {
  const base = stripTrailingSlashes(mockUpstreamUrl.trim() === "" ? "http://localhost:3001" : mockUpstreamUrl.trim());
  const url = `${base}/api/users`;
  return {
    name: DEMO_WORKFLOW_NAME,
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
        parameters: { url, method: "GET" },
      },
      {
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [400, 0],
        parameters: {},
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
      ...link("Webhook", "HTTP Request"),
      ...link("HTTP Request", "Set"),
      ...link("Set", "Code"),
    },
    settings: {},
  };
}

/**
 * Error-trigger workflow: subscribes workflow failures and POSTs them to the
 * Kintsugi `/error-hook`.
 */
export function buildErrorTriggerWorkflow(errorHookUrl: string): WorkflowJson {
  return {
    name: ERROR_TRIGGER_WORKFLOW_NAME,
    nodes: [
      {
        name: "Error Trigger",
        type: "n8n-nodes-base.errorTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        name: "POST to Kintsugi",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [200, 0],
        parameters: { url: errorHookUrl, method: "POST" },
      },
    ],
    connections: {
      ...link("Error Trigger", "POST to Kintsugi"),
    },
    settings: {},
  };
}

function workflowIdOf(payload: WorkflowJson): string | undefined {
  const id = payload.id;
  if (typeof id === "string" && id !== "") return id;
  if (typeof id === "number") return String(id);
  const data = payload.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === "string" && nested !== "") return nested;
    if (typeof nested === "number") return String(nested);
  }
  return undefined;
}

function workflowNameOf(payload: WorkflowJson): string | undefined {
  const name = payload.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Install both workflows idempotently (match-by-name: existing → update,
 * missing → create), then register the baseline snapshot of the demo
 * workflow. First-write-wins on the snapshot id keeps re-runs stable.
 */
export async function seedDemo(options: SeedDemoOptions): Promise<SeedDemoResult> {
  const { client, store, mockUpstreamUrl, errorHookUrl } = options;
  const demoPayload = buildDemoWorkflow(mockUpstreamUrl);
  const errorPayload = buildErrorTriggerWorkflow(errorHookUrl);

  let existing: WorkflowJson[];
  try {
    existing = await client.listWorkflows();
  } catch (cause) {
    throw new Error("seed-demo: failed to list n8n workflows", { cause });
  }
  const byName = new Map<string, WorkflowJson>();
  for (const item of existing) {
    const name = workflowNameOf(item);
    if (name !== undefined && !byName.has(name)) byName.set(name, item);
  }

  async function upsert(name: string, payload: WorkflowJson): Promise<string> {
    const found = byName.get(name);
    const foundId = found !== undefined ? workflowIdOf(found) : undefined;
    if (found !== undefined && foundId !== undefined) {
      let updated: WorkflowJson;
      try {
        updated = await client.updateWorkflow(foundId, { ...payload, id: foundId });
      } catch (cause) {
        throw new Error(`seed-demo: failed to update n8n workflow "${name}"`, { cause });
      }
      const id = workflowIdOf(updated) ?? foundId;
      if (id === undefined || id === "") throw new Error(`seed-demo: n8n update for "${name}" returned no id`);
      return id;
    }
    let created: WorkflowJson;
    try {
      created = await client.createWorkflow(payload);
    } catch (cause) {
      throw new Error(`seed-demo: failed to create n8n workflow "${name}"`, { cause });
    }
    const id = workflowIdOf(created);
    if (id === undefined || id === "") throw new Error(`seed-demo: n8n create for "${name}" returned no id`);
    return id;
  }

  const demoWorkflowId = await upsert(DEMO_WORKFLOW_NAME, demoPayload);
  const errorTriggerWorkflowId = await upsert(ERROR_TRIGGER_WORKFLOW_NAME, errorPayload);

  // Snapshot the installed demo workflow (id-pinned so the row survives
  // re-runs); the stored JSON carries the 4-node definition verbatim.
  store.insertSnapshot({
    id: BASELINE_SNAPSHOT_ID,
    eventId: BASELINE_EVENT_ID,
    kind: "baseline",
    workflowId: demoWorkflowId,
    snapshot: { ...demoPayload, id: demoWorkflowId },
  });

  return { demoWorkflowId, errorTriggerWorkflowId };
}
