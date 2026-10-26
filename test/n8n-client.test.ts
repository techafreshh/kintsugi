import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { N8nClient, N8nNotFoundError, type WorkflowJson } from "../src/n8n/client.js";

/** One request as seen by the stub server (node lowercases header names). */
interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type StubHandler = (req: { method: string; url: string; body: string }, res: ServerResponse) => void;

interface Stub {
  requests: RecordedRequest[];
  setHandler(handler: StubHandler): void;
  baseUrl(): string;
  close(): Promise<void>;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * In-memory n8n stub: listens on an ephemeral 127.0.0.1 port, records every
 * request, and dispatches to the per-test handler. Sockets are force-closed
 * on shutdown — undici's keep-alive would otherwise hang vitest.
 */
function startN8nStub(): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  let handler: StubHandler = (_req, res) => respond(res, 404, { message: "stub: no handler set" });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(
        { method: recorded.method, url: recorded.url, body: recorded.body },
        res,
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        requests,
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

/** Reserves a port with a listener, then closes it — a guaranteed-closed address. */
async function listenAndClose(): Promise<{ port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Consume the error event so the OS refusals during the test are never unhandled.
  server.on("error", () => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { port };
}

let stub: Stub;

beforeEach(async () => {
  stub = await startN8nStub();
});

afterEach(async () => {
  await stub.close();
});

describe("workflow round-trip", () => {
  it("createWorkflow then getWorkflow returns the created JSON, with the API key on both requests", async () => {
    const apiKey = "secret-test-key";
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey });
    const stored = new Map<string, WorkflowJson>();
    let nextId = 1;
    stub.setHandler((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/workflows") {
        const json = JSON.parse(req.body) as WorkflowJson;
        const id = `wf-${nextId++}`;
        stored.set(id, json);
        return respond(res, 200, { ...json, id });
      }
      const getMatch = /^\/api\/v1\/workflows\/([^/+]+)$/.exec(req.url);
      if (req.method === "GET" && getMatch) {
        const json = stored.get(getMatch[1] ?? "");
        if (json === undefined) return respond(res, 404, { message: "unknown workflow" });
        return respond(res, 200, { ...json, id: getMatch[1] });
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });

    const created = await client.createWorkflow({ name: "wf", nodes: [], settings: {} });
    const fetched = await client.getWorkflow(String(created.id));

    // Deep-equals the created one (the stub echoes stored JSON back verbatim).
    expect(fetched).toEqual(created);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]?.method).toBe("POST");
    expect(stub.requests[1]?.method).toBe("GET");
    for (const request of stub.requests) {
      expect(request.headers["x-n8n-api-key"]).toBe(apiKey);
    }
    // The body-carrying create request is JSON-encoded.
    expect(stub.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("strips trailing slashes from the base URL", async () => {
    const client = new N8nClient({ baseUrl: `${stub.baseUrl()}/`, apiKey: "k" });
    stub.setHandler((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/workflows/wf-1") {
        return respond(res, 200, { id: "wf-1" });
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });
    await client.getWorkflow("wf-1");
    expect(stub.requests[0]?.url).toBe("/api/v1/workflows/wf-1");
  });
});

describe("getExecution", () => {
  it("requests includeData=true and surfaces runData with status error", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/executions/x1?includeData=true") {
        return respond(res, 200, {
          id: "x1",
          status: "error",
          runData: { "Set A": [{ json: { ok: true } }] },
        });
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });

    const execution = await client.getExecution("x1");
    expect(execution.status).toBe("error");
    expect(execution.runData).toEqual({ "Set A": [{ json: { ok: true } }] });
    expect(stub.requests[0]?.url).toBe("/api/v1/executions/x1?includeData=true");
    expect(stub.requests[0]?.headers["x-n8n-api-key"]).toBe("k");
  });
});

describe("listExecutions", () => {
  it("returns the raw envelope from GET /api/v1/executions", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const envelope = { data: [{ id: "x1", status: "error" }], nextCursor: null };
    stub.setHandler((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/executions") {
        return respond(res, 200, envelope);
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });

    expect(await client.listExecutions()).toEqual(envelope);
    expect(stub.requests[0]?.method).toBe("GET");
    expect(stub.requests[0]?.url).toBe("/api/v1/executions");
  });
});

describe("probeRunEndpoint", () => {
  it("returns true on 200, false on 404, and probes with POST", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/workflows/wf-1/run") {
        return respond(res, 200, { ok: true });
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });
    expect(await client.probeRunEndpoint("wf-1")).toBe(true);
    expect(stub.requests[0]?.method).toBe("POST");

    stub.requests.length = 0;
    stub.setHandler((req, res) => respond(res, 404, { message: "no run route here" }));
    expect(await client.probeRunEndpoint("wf-1")).toBe(false);
    expect(stub.requests[0]?.method).toBe("POST");
  });

  it("treats any non-404 status as an exposed route (500 means registered but failing)", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((req, res) => respond(res, 500, { message: "boom" }));
    expect(await client.probeRunEndpoint("wf-1")).toBe(true);
    expect(stub.requests[0]?.method).toBe("POST");
  });
});

describe("404 mapping", () => {
  it("maps 404 on unknown ids to N8nNotFoundError with the right resource and id", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((_req, res) => respond(res, 404, { message: "not found" }));

    const cases: Array<[() => Promise<unknown>, "workflow" | "execution", string]> = [
      [() => client.getWorkflow("gone"), "workflow", "gone"],
      [() => client.updateWorkflow("gone", {}), "workflow", "gone"],
      [() => client.deleteWorkflow("gone"), "workflow", "gone"],
      [() => client.getExecution("gone"), "execution", "gone"],
    ];
    for (const [pending, resource, id] of cases) {
      // Promise is created and caught in the same tick, so no rejection goes
      // unhandled while earlier cases in the loop are still awaiting.
      const error = await pending().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(N8nNotFoundError);
      expect((error as N8nNotFoundError).resource).toBe(resource);
      expect((error as N8nNotFoundError).id).toBe(id);
      expect((error as N8nNotFoundError).message).toContain(`"${id}"`);
      expect((error as N8nNotFoundError).message).toContain("404");
    }
  });

  it("maps other non-2xx statuses to a plain Error, never N8nNotFoundError", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((_req, res) => respond(res, 500, { message: "internal" }));
    const error = await client.getWorkflow("wf-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(N8nNotFoundError);
    expect((error as Error).message).toContain("500");
  });

  it("wraps a non-JSON 2xx body in an explanatory Error", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    stub.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>404 page survived the router</html>");
    });
    await expect(client.getWorkflow("wf-1")).rejects.toThrow(/non-JSON/);
  });
});

describe("mutations passthrough", () => {
  it("updateWorkflow PUTs the given JSON; delete, activate and deactivate pass responses through", async () => {
    const client = new N8nClient({ baseUrl: stub.baseUrl(), apiKey: "k" });
    const payload: WorkflowJson = {
      name: "wf",
      nodes: [{ name: "Set A", type: "n8n-nodes-base.set" }],
      active: false,
    };
    stub.setHandler((req, res) => {
      if (req.method === "PUT" && req.url === "/api/v1/workflows/wf-1") {
        return respond(res, 200, { ...payload, id: "wf-1", version: 2 });
      }
      if (req.method === "DELETE" && req.url === "/api/v1/workflows/wf-1") {
        return respond(res, 200, { ...payload, id: "wf-1", deleted: true });
      }
      if (req.method === "POST" && req.url === "/api/v1/workflows/wf-1/activate") {
        return respond(res, 200, { id: "wf-1", active: true });
      }
      if (req.method === "POST" && req.url === "/api/v1/workflows/wf-1/deactivate") {
        return respond(res, 200, { id: "wf-1", active: false });
      }
      return respond(res, 500, { message: `stub: unexpected ${req.method} ${req.url}` });
    });

    expect(await client.updateWorkflow("wf-1", payload)).toEqual({ ...payload, id: "wf-1", version: 2 });
    expect(JSON.parse(stub.requests[0]?.body ?? "")).toEqual(payload);
    expect(stub.requests[0]?.headers["content-type"]).toBe("application/json");

    expect(await client.deleteWorkflow("wf-1")).toEqual({ ...payload, id: "wf-1", deleted: true });
    expect(stub.requests[1]?.method).toBe("DELETE");
    expect(stub.requests[1]?.url).toBe("/api/v1/workflows/wf-1");

    expect(await client.activateWorkflow("wf-1")).toEqual({ id: "wf-1", active: true });
    expect(stub.requests[2]?.url).toBe("/api/v1/workflows/wf-1/activate");
    expect(await client.deactivateWorkflow("wf-1")).toEqual({ id: "wf-1", active: false });
    expect(stub.requests[3]?.url).toBe("/api/v1/workflows/wf-1/deactivate");
  });
});

describe("offline behavior", () => {
  it("closed port: every method rejects with an Error instead of crashing", async () => {
    const { port } = await listenAndClose();
    const dead = new N8nClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" });
    await expect(dead.getWorkflow("wf-1")).rejects.toBeInstanceOf(Error);
    await expect(dead.createWorkflow({ name: "wf" })).rejects.toBeInstanceOf(Error);
    await expect(dead.updateWorkflow("wf-1", {})).rejects.toBeInstanceOf(Error);
    await expect(dead.deleteWorkflow("wf-1")).rejects.toBeInstanceOf(Error);
    await expect(dead.activateWorkflow("wf-1")).rejects.toBeInstanceOf(Error);
    await expect(dead.deactivateWorkflow("wf-1")).rejects.toBeInstanceOf(Error);
    await expect(dead.listExecutions()).rejects.toBeInstanceOf(Error);
    await expect(dead.getExecution("x1")).rejects.toBeInstanceOf(Error);
    await expect(dead.probeRunEndpoint("wf-1")).rejects.toBeInstanceOf(Error);
  });

  it("constructor throws TypeError on blank baseUrl, blank apiKey, or invalid timeoutMs", () => {
    expect(() => new N8nClient({ baseUrl: "", apiKey: "k" })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "   ", apiKey: "k" })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "http://x", apiKey: "" })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "http://x", apiKey: " \t " })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "http://x", apiKey: "k", timeoutMs: 0 })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "http://x", apiKey: "k", timeoutMs: -1 })).toThrow(TypeError);
    expect(() => new N8nClient({ baseUrl: "http://x", apiKey: "k", timeoutMs: Infinity })).toThrow(TypeError);
  });
});
