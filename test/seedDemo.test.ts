import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { N8nClient, type WorkflowJson } from "../src/n8n/client.js";
import {
  BASELINE_EVENT_ID,
  BASELINE_SNAPSHOT_ID,
  buildDemoWorkflow,
  buildErrorTriggerWorkflow,
  connectionChainNames,
  DEMO_WORKFLOW_NAME,
  ERROR_TRIGGER_WORKFLOW_NAME,
  seedDemo,
} from "../src/seeding/seedDemo.js";
import { openStore, type Store } from "../src/store/store.js";

interface Stub {
  baseUrl(): string;
  workflowCount(): number;
  close(): Promise<void>;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Name-persistent n8n stub: workflows survive across seeder runs in the same
 * test, so the update-in-place path can be observed. Lists answer the
 * `{data:[...]}` envelope real n8n uses.
 */
function startN8nStub(): Promise<Stub> {
  const stored = new Map<string, WorkflowJson>();
  let nextId = 1;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.method ?? "";
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      if (method === "GET" && url === "/api/v1/workflows") {
        return respond(res, 200, { data: [...stored.entries()].map(([id, json]) => ({ ...json, id })) });
      }
      if (method === "POST" && url === "/api/v1/workflows") {
        const json = JSON.parse(body) as WorkflowJson;
        const id = `wf-${nextId++}`;
        stored.set(id, json);
        return respond(res, 200, { ...json, id });
      }
      const idMatch = /^\/api\/v1\/workflows\/([^/]+)$/.exec(url);
      if (idMatch) {
        const id = idMatch[1] ?? "";
        if (method === "GET") {
          const json = stored.get(id);
          if (json === undefined) return respond(res, 404, { message: "not found" });
          return respond(res, 200, { ...json, id });
        }
        if (method === "PUT") {
          if (!stored.has(id)) return respond(res, 404, { message: "not found" });
          const json = JSON.parse(body) as WorkflowJson;
          stored.set(id, json);
          return respond(res, 200, { ...json, id });
        }
      }
      return respond(res, 500, { message: `stub: unexpected ${method} ${url}` });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        workflowCount: () => stored.size,
        close: () =>
          new Promise((done) => {
            server.closeIdleConnections();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

let stub: Stub;
let store: Store;

const MOCK_UPSTREAM = "http://chaos-stub:3001";
const ERROR_HOOK = "http://kintsugi:8080/error-hook";

beforeEach(async () => {
  stub = await startN8nStub();
  store = openStore(":memory:");
});

afterEach(async () => {
  store.close();
  await stub.close();
});

function nodeByName(workflow: WorkflowJson, name: string): Record<string, unknown> {
  const nodes = workflow.nodes as Array<Record<string, unknown>>;
  const found = nodes.find((node) => node.name === name);
  if (found === undefined) throw new Error(`test: node "${name}" missing`);
  return found;
}

describe("seedDemo", () => {
  it("creates both workflows and registers a 4-node baseline snapshot", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const result = await seedDemo({
      client,
      store,
      mockUpstreamUrl: MOCK_UPSTREAM,
      errorHookUrl: ERROR_HOOK,
    });

    expect(result.demoWorkflowId).toMatch(/^wf-/);
    expect(result.errorTriggerWorkflowId).toMatch(/^wf-/);
    expect(result.demoWorkflowId).not.toBe(result.errorTriggerWorkflowId);
    expect(stub.workflowCount()).toBe(2);

    const row = store.getSnapshot(BASELINE_SNAPSHOT_ID);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("baseline");
    expect(row?.eventId).toBe(BASELINE_EVENT_ID);
    expect(row?.workflowId).toBe(result.demoWorkflowId);
    const snapshot = row?.snapshot as WorkflowJson;
    expect((snapshot.nodes as unknown[])).toHaveLength(4);
  });

  it("is idempotent: two runs still yield exactly 2 workflows with stable ids", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const first = await seedDemo({ client, store, mockUpstreamUrl: MOCK_UPSTREAM, errorHookUrl: ERROR_HOOK });
    const second = await seedDemo({ client, store, mockUpstreamUrl: MOCK_UPSTREAM, errorHookUrl: ERROR_HOOK });

    expect(stub.workflowCount()).toBe(2);
    expect(second.demoWorkflowId).toBe(first.demoWorkflowId);
    expect(second.errorTriggerWorkflowId).toBe(first.errorTriggerWorkflowId);
    // Baseline row survives the second run (first-write-wins) still pinned to the demo id.
    expect(store.getSnapshot(BASELINE_SNAPSHOT_ID)?.workflowId).toBe(first.demoWorkflowId);
  });

  it("fetched demo workflow walks the connections topology in exact node order", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const { demoWorkflowId } = await seedDemo({
      client,
      store,
      mockUpstreamUrl: MOCK_UPSTREAM,
      errorHookUrl: ERROR_HOOK,
    });

    const fetched = await client.getWorkflow(demoWorkflowId);
    expect(connectionChainNames(fetched)).toEqual(["Webhook", "HTTP Request", "Set", "Code"]);
  });

  it("wires the HTTP node to the injected mock-upstream base and the trigger to the injected hook URL", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const { demoWorkflowId, errorTriggerWorkflowId } = await seedDemo({
      client,
      store,
      mockUpstreamUrl: MOCK_UPSTREAM,
      errorHookUrl: ERROR_HOOK,
    });

    const demo = await client.getWorkflow(demoWorkflowId);
    const httpParams = nodeByName(demo, "HTTP Request").parameters as Record<string, unknown>;
    expect(httpParams.url).toBe(`${MOCK_UPSTREAM}/api/users`);
    expect(httpParams.method).toBe("GET");

    const trigger = await client.getWorkflow(errorTriggerWorkflowId);
    const postParams = nodeByName(trigger, "POST to Kintsugi").parameters as Record<string, unknown>;
    expect(postParams.url).toBe(ERROR_HOOK);
    expect(postParams.method).toBe("POST");
  });
});

describe("workflow builders", () => {
  it("demo builder pins names, node types, and the 4-link chain", () => {
    const workflow = buildDemoWorkflow(MOCK_UPSTREAM);
    expect(workflow.name).toBe(DEMO_WORKFLOW_NAME);
    const nodes = workflow.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node.name)).toEqual(["Webhook", "HTTP Request", "Set", "Code"]);
    expect(nodes.map((node) => node.type)).toEqual([
      "n8n-nodes-base.webhook",
      "n8n-nodes-base.httpRequest",
      "n8n-nodes-base.set",
      "n8n-nodes-base.code",
    ]);
    expect(connectionChainNames(workflow)).toEqual(["Webhook", "HTTP Request", "Set", "Code"]);
  });

  it("error-trigger builder posts failures to the hook URL", () => {
    const workflow = buildErrorTriggerWorkflow(ERROR_HOOK);
    expect(workflow.name).toBe(ERROR_TRIGGER_WORKFLOW_NAME);
    const nodes = workflow.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node.name)).toEqual(["Error Trigger", "POST to Kintsugi"]);
    const params = nodes[1]?.parameters as Record<string, unknown>;
    expect(params.url).toBe(ERROR_HOOK);
  });
});
