import { describe, expect, it } from "vitest";
import { buildWorkflowView, type WorkflowView } from "../src/llm/workflowView.js";

type Node = Record<string, unknown>;
type RunTask = Record<string, unknown>;

const node = (name: string, type: string, extra: Node = {}): Node => ({
  name,
  type,
  parameters: {},
  ...extra,
});

const workflow = (nodes: Node[], top: Record<string, unknown> = {}): Record<string, unknown> => ({
  nodes,
  ...top,
});

/** Full execution shape: the runData map nested under data.resultData. */
const execRunData = (
  map: Record<string, RunTask[]>,
  top: Record<string, unknown> = {},
): Record<string, unknown> => ({
  data: { resultData: { runData: map } },
  ...top,
});

const view = (wf: unknown, run: unknown, lastGood?: unknown): WorkflowView =>
  buildWorkflowView(wf, run, lastGood);

describe("acceptance: sanitized compact workflow view", () => {
  it("HTTP node error is redacted: no sk-abc123 anywhere, [REDACTED] in failingNode.error", () => {
    const wf = workflow([
      node("HTTP", "n8n-nodes-base.httpRequest", { parameters: { url: "https://api.example.com" } }),
    ]);
    const run = execRunData({
      HTTP: [{ data: {}, error: { message: 'Error: start failed; status 502; body "Authorization: Bearer sk-abc123"' } }],
    });
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("HTTP");
    expect(v.failingNode?.type).toBe("n8n-nodes-base.httpRequest");
    expect(JSON.stringify(v)).not.toContain("sk-abc123");
    expect(v.failingNode?.error).toContain("[REDACTED]");
  });

  it("runData failing node Set1 wins failingNode and node count is preserved", () => {
    const wf = workflow([node("HTTP", "n8n-nodes-base.httpRequest"), node("Set1", "n8n-nodes-base.set")]);
    const run = execRunData({
      HTTP: [{ data: { main: [[{ json: { q: 1 } }]] } }],
      Set1: [{ data: { main: [[{ json: { value: "2" } }]] } }],
    });
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("Set1");
    expect(v.nodes.length).toBe(2);
  });

  it("a node with a credentials property leaves zero occurrences of the literal", () => {
    const wf = workflow([
      node("HTTP", "n8n-nodes-base.httpRequest", {
        credentials: { httpHeaderAuth: { id: "7", name: "admin-cred" } },
      }),
    ]);
    const v = view(wf, execRunData({}));
    expect(JSON.stringify(v)).not.toContain("credentials");
  });

  it("lastKnownGoodDiff changed leafPath from the snapshot diff, null when omitted", () => {
    const before = workflow([node("Set1", "n8n-nodes-base.set", { parameters: { value: "1" } })]);
    const after = workflow([node("Set1", "n8n-nodes-base.set", { parameters: { value: "2" } })]);
    const v = view(after, execRunData({}), before);
    expect(v.lastKnownGoodDiff?.changed[0]?.leafPath).toBe("nodes.Set1.parameters.value");
    expect(v.lastKnownGoodDiff?.changed[0]?.before).toBe("1");
    expect(v.lastKnownGoodDiff?.changed[0]?.after).toBe("2");
    expect(view(after, execRunData({})).lastKnownGoodDiff).toBeNull();
  });
});

describe("nodes and edges", () => {
  it("connections flatten to {from,to,type,sourceIndex,targetIndex}; unusable targets are skipped", () => {
    const wf = workflow([], {
      connections: {
        A: { main: [[{ node: "B", type: "main", index: 0 }], [{ bogus: true }, { node: "C" }]] },
      },
    });
    const v = view(wf, null);
    expect(v.edges).toEqual([
      { from: "A", to: "B", type: "main", sourceIndex: 0, targetIndex: 0 },
      { from: "A", to: "C", type: "main", sourceIndex: 1, targetIndex: 0 },
    ]);
  });

  it("node id falls back to name, then to empty for a nameless node", () => {
    const wf = { nodes: [{ id: "n-1", name: "WithId", type: "t" }, { name: "NoId", type: "t" }, { type: "t" }] };
    const v = view(wf, null);
    expect(v.nodes.map((n) => n.id)).toEqual(["n-1", "NoId", ""]);
    expect(v.nodes.map((n) => n.name)).toEqual(["WithId", "NoId", ""]);
  });

  it("nodes as a pre-keyed object map is accepted, map key becomes the name", () => {
    const wf = { nodes: { Set1: { type: "n8n-nodes-base.set", parameters: { value: "2" } } } };
    const lastGood = { nodes: { Set1: { type: "n8n-nodes-base.set", parameters: { value: "1" } } } };
    const v = view(wf, null, lastGood);
    expect(v.nodes.length).toBe(1);
    expect(v.nodes[0]?.name).toBe("Set1");
    expect(v.lastKnownGoodDiff?.changed[0]?.leafPath).toBe("nodes.Set1.parameters.value");
  });

  it("a 300+ char parameter string is truncated with an ellipsis at <= 201 chars", () => {
    const wf = workflow([node("A", "t", { parameters: { long: "x".repeat(300) } })]);
    const v = view(wf, null);
    const params = v.nodes[0]?.parameters as { long: string };
    expect(params.long.length).toBe(201);
    expect(params.long.endsWith("…")).toBe(true);
  });

  it("arrays cap at 10 items and nesting caps at depth 8 with a [truncated] marker", () => {
    const deep = { d1: { d2: { d3: { d4: { d5: { d6: { d7: { d8: "too deep" } } } } } } } };
    const wf = workflow([
      node("A", "t", { parameters: { list: Array.from({ length: 15 }, (_, i) => i), deep } }),
    ]);
    const v = view(wf, null);
    const params = v.nodes[0]?.parameters as { list: number[]; deep: Record<string, unknown> };
    expect(params.list).toHaveLength(10);
    let level: Record<string, unknown> = params.deep;
    for (const key of ["d1", "d2", "d3", "d4", "d5", "d6"]) {
      level = level[key] as Record<string, unknown>;
    }
    expect(level.d7).toBe("[truncated]");
  });
});

describe("secret sanitation across view fields", () => {
  it("secrets in failingNode.inputData and triggerPayload become [REDACTED]", () => {
    const wf = workflow(
      [node("Start", "n8n-nodes-base.manualTrigger"), node("Set1", "n8n-nodes-base.set")],
      { connections: { Start: { main: [[{ node: "Set1", type: "main", index: 0 }]] } } },
    );
    const run = execRunData({
      Start: [{ data: { main: [[{ json: { auth: "Bearer sk-abc123" } }]] } }],
      Set1: [{ data: { main: [[{ json: { token: "sk-1234567890abcdef1234" } }]] }, error: { message: "boom" } }],
    });
    const v = view(wf, run);
    const s = JSON.stringify(v);
    expect(s).not.toContain("sk-abc123");
    expect(s).not.toContain("sk-1234567890abcdef1234");
    expect(s).toContain("[REDACTED]");
  });
});

describe("failing-node detection channels", () => {
  it("channel 1: first runData entry whose task carries an error property wins", () => {
    const wf = workflow([node("Trigger", "n8n-nodes-base.manualTrigger"), node("Set1", "n8n-nodes-base.set")]);
    const run = execRunData({
      Trigger: [{ data: {} }],
      Set1: [{ data: {}, error: { message: "boom" } }],
    });
    const v = view(wf, run);
    expect(v.failingNode).toEqual({ name: "Set1", type: "n8n-nodes-base.set", error: "boom", inputData: {} });
  });

  it("channel 2: execution.lastNodeExecuted with execution.error (Error-Trigger shape)", () => {
    const wf = workflow([node("Set1", "n8n-nodes-base.set")]);
    const run = { execution: { lastNodeExecuted: "Set1", error: { message: "Connection refused" } } };
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("Set1");
    expect(v.failingNode?.type).toBe("n8n-nodes-base.set");
    expect(v.failingNode?.error).toBe("Connection refused");
    expect(v.failingNode?.inputData).toBeNull();
  });

  it("channel 2: top-level lastNodeExecuted with top-level error resolves the run-data entry", () => {
    const wf = workflow([node("HTTP", "n8n-nodes-base.httpRequest")]);
    const run = execRunData({ HTTP: [{ data: { headers: { "X-Retry": "true" } } }] }, {
      lastNodeExecuted: "HTTP",
      error: { message: "ECONNRESET" },
    });
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("HTTP");
    expect(v.failingNode?.error).toBe("ECONNRESET");
    expect(v.failingNode?.inputData).toEqual({ headers: { "X-Retry": "true" } });
  });

  it("channel 3: no error marker anywhere -> the last runData entry is presumed failing", () => {
    const wf = workflow([node("Trigger", "n8n-nodes-base.manualTrigger"), node("Set1", "n8n-nodes-base.set")]);
    const run = execRunData({
      Trigger: [{ data: { main: [] } }],
      Set1: [{ data: { main: [[{ json: { value: "2" } }]] } }],
    });
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("Set1");
    expect(v.failingNode?.error).toBeNull();
    expect(v.failingNode?.type).toBe("n8n-nodes-base.set");
  });

  it("runData accepted directly as the {nodeName: [task]} map", () => {
    const wf = workflow([node("Set1", "n8n-nodes-base.set")]);
    const run = { Set1: [{ data: { x: 2 }, error: { message: "kaboom" } }] };
    const v = view(wf, run);
    expect(v.failingNode?.name).toBe("Set1");
    expect(v.failingNode?.error).toBe("kaboom");
    expect(v.failingNode?.inputData).toEqual({ x: 2 });
  });
});

describe("trigger payload", () => {
  it("input data of the first trigger-typed node, sanitized", () => {
    const wf = workflow([node("Start", "n8n-nodes-base.manualTrigger"), node("Set1", "n8n-nodes-base.set")]);
    const run = execRunData({
      Start: [{ data: { main: [[{ json: { auth: "Bearer sk-abc123" } }]] } }],
      Set1: [{ data: {} }],
    });
    const v = view(wf, run);
    expect(v.triggerPayload).toEqual({ main: [[{ json: { auth: "Bearer [REDACTED]" } }]] });
  });

  it("falls back to the first node with no inbound edge (e.g. a webhook node)", () => {
    const wf = workflow(
      [node("Webhook", "n8n-nodes-base.webhook"), node("Set1", "n8n-nodes-base.set")],
      { connections: { Webhook: { main: [[{ node: "Set1", type: "main", index: 0 }]] } } },
    );
    const run = execRunData({
      Webhook: [{ data: { main: [[{ json: { query: "q=1" } }]] } }],
      Set1: [{ data: {} }],
    });
    const v = view(wf, run);
    expect(v.triggerPayload).toEqual({ main: [[{ json: { query: "q=1" } }]] });
  });

  it("falls back to the execution-level startData object", () => {
    const run = { data: { resultData: { startData: { mode: "webhook" }, runData: {} } } };
    const v = view(workflow([]), run);
    expect(v.triggerPayload).toEqual({ mode: "webhook" });
    expect(v.failingNode).toBeNull();
  });
});

describe("never throws on malformed input", () => {
  it("junk inputs of any shape yield empty lists and nulls", () => {
    for (const junk of [null, 42, "{", "nope", {}]) {
      expect(buildWorkflowView(junk, junk)).toEqual({
        nodes: [],
        edges: [],
        failingNode: null,
        triggerPayload: null,
        lastKnownGoodDiff: null,
      });
    }
  });

  it("an empty runData map yields no failing node and no trigger payload", () => {
    const v = view(workflow([node("A", "t")]), execRunData({}));
    expect(v.failingNode).toBeNull();
    expect(v.triggerPayload).toBeNull();
  });
});
