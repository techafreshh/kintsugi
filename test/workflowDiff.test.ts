import { describe, expect, it } from "vitest";
import { diffWorkflows, type WorkflowDiff } from "../src/diff/workflowDiff.js";

type Node = Record<string, unknown>;

const workflow = (nodes: Node[], top: Record<string, unknown> = {}): Record<string, unknown> => ({
  nodes,
  ...top,
});

const setNode = (value: string): Node => ({
  name: "Set1",
  type: "n8n-nodes-base.set",
  position: [250, 300],
  parameters: { value },
});

const named = (name: string): Node => ({ name, type: "n8n-nodes-base.noOp", position: [0, 0], parameters: {} });

const diff = (before: unknown, after: unknown): WorkflowDiff => diffWorkflows(before, after);

describe("acceptance: changed leaf entries", () => {
  it("one changed parameter -> exactly one entry with leafPath and raw before/after", () => {
    const result = diff(workflow([setNode("1")]), workflow([setNode("2")]));
    expect(result.changed).toEqual([
      { name: "Set1", leafPath: "nodes.Set1.parameters.value", before: "1", after: "2" },
    ]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("nodes only in one side -> added/removed names, each counting one structural change", () => {
    const result = diff(workflow([setNode("1"), named("Old")]), workflow([setNode("1"), named("New")]));
    expect(result.added).toEqual([{ name: "New" }]);
    expect(result.removed).toEqual([{ name: "Old" }]);
    expect(result.changed).toEqual([]);
    expect(result.changedLineCount).toBe(2);
  });

  it("identical workflows -> all arrays empty and changedLineCount 0", () => {
    const wf = workflow([setNode("1")], {
      name: "chaos",
      settings: { executionOrder: "v1" },
      connections: { Set1: { main: [[{ node: "Next", type: "main", index: 0 }]] } },
    });
    const result = diff(wf, wf);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.changedLineCount).toBe(0);
  });

  it("same content in separate objects (different key order) is still zero changes", () => {
    const before = workflow([{ parameters: { value: "1" }, name: "Set1" }]);
    const after = workflow([{ name: "Set1", parameters: { value: "1" } }]);
    expect(diff(before, after)).toEqual(diff(before, before));
  });

  it("two changed leaves in the same node -> changedLineCount 2", () => {
    const params = (value: string, seconds: number) => ({ value, seconds });
    const result = diff(
      workflow([{ ...setNode("1"), parameters: params("1", 5) }]),
      workflow([{ ...setNode("2"), parameters: params("2", 9) }]),
    );
    expect(result.changed).toHaveLength(2);
    expect(result.changedLineCount).toBe(2);
  });
});

describe("leaf paths", () => {
  it("node names with spaces appear verbatim in the dotted path", () => {
    const http = (url: string): Node => ({
      name: "My HTTP Request",
      type: "n8n-nodes-base.httpRequest",
      parameters: { url },
    });
    const result = diff(workflow([http("https://a")]), workflow([http("https://b")]));
    expect(result.changed[0]?.leafPath).toBe("nodes.My HTTP Request.parameters.url");
  });

  it("a changed node type yields nodes.<name>.type", () => {
    const result = diff(
      workflow([{ ...setNode("1"), type: "n8n-nodes-base.set" }]),
      workflow([{ ...setNode("1"), type: "n8n-nodes-code.code" }]),
    );
    expect(result.changed[0]).toEqual({
      name: "Set1",
      leafPath: "nodes.Set1.type",
      before: "n8n-nodes-base.set",
      after: "n8n-nodes-code.code",
    });
  });

  it("a key added inside a node counts one entry with the missing side undefined", () => {
    const result = diff(workflow([setNode("1")]), workflow([{ ...setNode("1"), notes: "hi" }]));
    expect(result.changed).toEqual([
      { name: "Set1", leafPath: "nodes.Set1.notes", before: undefined, after: "hi" },
    ]);
    expect(result.changedLineCount).toBe(1);
  });
});

describe("top-level fields", () => {
  it("changed settings value is one entry with name \"\"", () => {
    const result = diff(
      workflow([], { settings: { executionOrder: "v0" } }),
      workflow([], { settings: { executionOrder: "v1" } }),
    );
    expect(result.changed).toEqual([
      { name: "", leafPath: "settings.executionOrder", before: "v0", after: "v1" },
    ]);
    expect(result.changedLineCount).toBe(1);
  });

  it("a changed connections array is one leaf, not per-element noise", () => {
    const connections = (target: string) => ({ Set1: { main: [[{ node: target, type: "main", index: 0 }]] } });
    const result = diff(
      workflow([], { connections: connections("A") }),
      workflow([], { connections: connections("B") }),
    );
    expect(result.changed).toEqual([
      { name: "", leafPath: "connections.Set1.main", before: connections("A").Set1.main, after: connections("B").Set1.main },
    ]);
  });
});

describe("added/removed are sorted by name and changed by leafPath", () => {
  it("output is deterministic regardless of node order between the two sides", () => {
    const result = diff(
      workflow([named("Zulu"), named("Alpha")]),
      workflow([named("Yankee"), named("Bravo")]),
    );
    expect(result.added.map((entry) => entry.name)).toEqual(["Bravo", "Yankee"]);
    expect(result.removed.map((entry) => entry.name)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("changedLineCount", () => {
  const cases: Array<{ name: string; before: unknown; after: unknown; expected: number }> = [
    { name: "no changes -> 0", before: workflow([]), after: workflow([]), expected: 0 },
    { name: "one added node -> 1", before: workflow([]), after: workflow([named("A")]), expected: 1 },
    { name: "one removed node -> 1", before: workflow([named("A")]), after: workflow([]), expected: 1 },
    {
      name: "addition + removal + one leaf -> 3",
      before: workflow([named("A")], { settings: { keep: 1, drop: true } }),
      after: workflow([named("B")], { settings: { keep: 2, drop: true } }),
      expected: 3,
    },
    {
      name: "two leaf changes across two nodes -> 2",
      before: workflow([setNode("1"), { ...named("C"), parameters: { mode: "auto" } }]),
      after: workflow([setNode("2"), { ...named("C"), parameters: { mode: "manual" } }]),
      expected: 2,
    },
    {
      name: "one unequal array inside a node -> 1",
      before: workflow([{ ...setNode("1"), position: [1, 2] }]),
      after: workflow([{ ...setNode("1"), position: [3, 4, 5] }]),
      expected: 1,
    },
  ];
  for (const { name, before, after, expected } of cases) {
    it(name, () => {
      expect(diffWorkflows(before, after).changedLineCount).toBe(expected);
    });
  }
});

describe("never throws on malformed input", () => {
  it("supports null vs a workflow", () => {
    expect(diff(null, { nodes: [] })).toEqual({ added: [], removed: [], changed: [], changedLineCount: 0 });
  });

  it("non-object inputs are empty records -> zero changes", () => {
    expect(diff("nope", 42)).toEqual({ added: [], removed: [], changed: [], changedLineCount: 0 });
  });

  it("missing nodes on one side is no change", () => {
    expect(diff({ name: "wf" }, { name: "wf" }).changedLineCount).toBe(0);
  });

  it("node entries without a string name are skipped, named nodes still diff", () => {
    const result = diff(
      { nodes: [{ id: "1" }, { name: "A" }] },
      { nodes: [{ id: "2" }, { name: "A", parameters: { x: 1 } }] },
    );
    expect(result.changed).toEqual([
      { name: "A", leafPath: "nodes.A.parameters", before: undefined, after: { x: 1 } },
    ]);
  });

  it("nodes as a pre-keyed object map is accepted and keyed by the map key", () => {
    const result = diff(
      { nodes: { Set1: { name: "Set1", parameters: { value: "1" } } } },
      { nodes: { Set1: { name: "Set1", parameters: { value: "2" } } } },
    );
    expect(result.changed).toEqual([
      { name: "Set1", leafPath: "nodes.Set1.parameters.value", before: "1", after: "2" },
    ]);
  });
});
