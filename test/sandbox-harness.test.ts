import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { N8nClient, type WorkflowJson } from "../src/n8n/client.js";
import { runSandbox } from "../src/sandbox/harness.js";

type StubHandler = (req: { method: string; url: string; body: string }, res: ServerResponse) => void;

interface Stub {
  setHandler(handler: StubHandler): void;
  baseUrl(): string;
  close(): Promise<void>;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * In-memory n8n stub mirroring test/n8n-client.test.ts: workflows live in a
 * Map, every request is recorded, sockets are force-closed on shutdown.
 */
function startN8nStub(store: Map<string, WorkflowJson>): Promise<Stub> {
  let handler: StubHandler = (_req, res) => respond(res, 404, { message: "stub: no handler set" });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      handler(
        { method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") },
        res,
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      void store;
      resolve({
        setHandler: (next) => {
          handler = next;
        },
        baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
          new Promise((resolveClose) => {
            server.closeIdleConnections();
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

let stub: Stub;

beforeEach(async () => {
  stub = await startN8nStub(new Map());
});

afterEach(async () => {
  await stub.close();
});

function installCrud(store: Map<string, WorkflowJson>, runStatus: number, runBody: unknown): { createdNames: string[] } {
  const createdNames: string[] = [];
  let nextId = 100;
  stub.setHandler((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/workflows") {
      const json = JSON.parse(req.body) as WorkflowJson;
      createdNames.push(String((json as Record<string, unknown>).name ?? ""));
      const id = `sandbox-${nextId++}`;
      store.set(id, json);
      return respond(res, 200, { ...json, id });
    }
    const oneMatch = /^\/api\/v1\/workflows\/([^/+]+)$/.exec(req.url);
    if (oneMatch) {
      const id = oneMatch[1] ?? "";
      if (req.method === "GET") {
        const json = store.get(id);
        if (json === undefined) return respond(res, 404, { message: "unknown workflow" });
        return respond(res, 200, { ...json, id });
      }
      if (req.method === "DELETE") {
        const json = store.get(id);
        if (json === undefined) return respond(res, 404, { message: "unknown workflow" });
        store.delete(id);
        return respond(res, 200, { ...json, id, deleted: true });
      }
    }
    const runMatch = /^\/api\/v1\/workflows\/([^/+]+)\/run$/.exec(req.url);
    if (req.method === "POST" && runMatch) {
      return respond(res, runStatus, runBody);
    }
    return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
  });
  return { createdNames };
}

function originalWorkflow(): WorkflowJson {
  return {
    name: "orders-sync",
    nodes: [
      { name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", position: [0, 0], parameters: {} },
      { name: "Set", type: "n8n-nodes-base.set", position: [200, 0], parameters: { value: 1 } },
    ],
    connections: {},
  };
}

describe("sandbox harness", () => {
  it("names the copy sandbox-* and deletes it after the run when keep is unset", async () => {
    const store = new Map<string, WorkflowJson>([["wf-1", originalWorkflow()]]);
    const { createdNames } = installCrud(store, 200, { success: true, data: [{ ok: true }] });
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });

    const result = await runSandbox("wf-1", originalWorkflow(), "exec-1", { client });

    expect(result.strategy).toBe("run-endpoint");
    expect(result.sandboxName.startsWith("sandbox-")).toBe(true);
    expect(createdNames.length).toBe(1);
    expect(createdNames[0]?.startsWith("sandbox-")).toBe(true);
    expect(result.sandboxWorkflowId.startsWith("sandbox-")).toBe(true);
    // The sandbox copy is gone; only the original remains.
    expect(store.has(result.sandboxWorkflowId)).toBe(false);
    expect(store.has("wf-1")).toBe(true);
    expect(store.size).toBe(1);
  });

  it("falls back to webhook execution when the run endpoint answers 404", async () => {
    const store = new Map<string, WorkflowJson>([["wf-1", originalWorkflow()]]);
    installCrud(store, 404, { message: "no run route here" });
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });

    const result = await runSandbox({
      workflowId: "wf-1",
      snapshot: originalWorkflow(),
      needleId: "exec-1",
      client,
    });

    expect(result.strategy).toBe("webhook-fallback");
    // Cleanup still runs on the fallback path.
    expect(result.sandboxWorkflowId === "" || !store.has(result.sandboxWorkflowId)).toBe(true);
    expect(store.has("wf-1")).toBe(true);
  });

  it("keeps the sandbox copy when sandboxKeep is true", async () => {
    const store = new Map<string, WorkflowJson>([["wf-1", originalWorkflow()]]);
    installCrud(store, 200, { success: true });
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });

    const result = await runSandbox("wf-1", originalWorkflow(), "exec-1", {
      client,
      sandboxKeep: true,
    });

    expect(result.sandboxName.startsWith("sandbox-")).toBe(true);
    expect(store.has(result.sandboxWorkflowId)).toBe(true);
  });
});
