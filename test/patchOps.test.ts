import { describe, expect, it } from "vitest";
import { applyPatchOps, PatchValidationError } from "../src/patch/patchOps.js";
import { insertNodeRewire, listEdges, removeNodeRewire } from "../src/patch/connections.js";

type Node = Record<string, unknown>;
type Workflow = Record<string, unknown>;

const named = (name: string, extra: Record<string, unknown> = {}): Node => ({
  name,
  type: "n8n-nodes-base.noOp",
  position: [0, 0],
  parameters: {},
  ...extra,
});

/** Chain A->B->C: three nodes plus the matching connections record. */
const chain = (): Workflow => ({
  nodes: [named("A"), named("B"), named("C")],
  connections: {
    A: { main: [[{ node: "B", type: "main", index: 0 }]] },
    B: { main: [[{ node: "C", type: "main", index: 0 }]] },
  },
});

const withParams = (value: string): Workflow => ({
  nodes: [{ ...named("Set1"), parameters: { value, keep: true } }],
  connections: {},
});

describe("acceptance: set_parameter on an existing path changes only that leaf", () => {
  it("writes the value and leaves every other node untouched", () => {
    const before = withParams("1");
    const after = applyPatchOps(before, [
      { op: "set_parameter", path: "nodes.Set1.parameters.value", value: "2" },
    ]);
    expect((after.nodes as Node[])[0]).toMatchObject({ parameters: { value: "2", keep: true } });
    expect(after.nodes).toHaveLength(1);
  });

  it("resolves verbatim names with spaces like diff leaf paths do", () => {
    const workflow: Workflow = {
      nodes: [{ ...named("My HTTP Request"), parameters: { url: "https://a" } }],
      connections: {},
    };
    const after = applyPatchOps(workflow, [
      { op: "set_parameter", path: "nodes.My HTTP Request.parameters.url", value: "https://b" },
    ]);
    expect((after.nodes as Node[])[0]).toMatchObject({ parameters: { url: "https://b" } });
  });

  it("indexes into arrays with numeric segments", () => {
    const workflow: Workflow = {
      nodes: [{ ...named("Set1"), parameters: { items: [{ v: 1 }, { v: 2 }] } }],
      connections: {},
    };
    const after = applyPatchOps(workflow, [
      { op: "set_parameter", path: "nodes.Set1.parameters.items.1.v", value: 9 },
    ]);
    expect((after.nodes as Node[])[0]).toMatchObject({ parameters: { items: [{ v: 1 }, { v: 9 }] } });
  });
});

describe("acceptance: set_parameter on a missing path throws unknown path", () => {
  it("nodes.Ghost.parameters.x -> PatchValidationError containing 'unknown path'", () => {
    expect(() =>
      applyPatchOps(withParams("1"), [
        { op: "set_parameter", path: "nodes.Ghost.parameters.x", value: 1 },
      ]),
    ).toThrowError(PatchValidationError);
    expect(() =>
      applyPatchOps(withParams("1"), [
        { op: "set_parameter", path: "nodes.Ghost.parameters.x", value: 1 },
      ]),
    ).toThrowError(/unknown path/);
  });

  it("missing leaf under an existing node is also unknown path, never created", () => {
    const workflow = withParams("1");
    expect(() =>
      applyPatchOps(workflow, [
        { op: "set_parameter", path: "nodes.Set1.parameters.missing", value: 1 },
      ]),
    ).toThrowError(/unknown path/);
    expect(workflow.nodes).toHaveLength(1);
  });

  it("out-of-bounds array index is unknown path", () => {
    const workflow: Workflow = {
      nodes: [{ ...named("Set1"), parameters: { items: [{ v: 1 }] } }],
      connections: {},
    };
    expect(() =>
      applyPatchOps(workflow, [
        { op: "set_parameter", path: "nodes.Set1.parameters.items.5.v", value: 9 },
      ]),
    ).toThrowError(/unknown path/);
  });
});

describe("acceptance: set_on_error whitelist", () => {
  it("bypassEverything -> PatchValidationError containing 'onError'", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_on_error", nodeId: "B", mode: "bypassEverything" }]),
    ).toThrowError(PatchValidationError);
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_on_error", nodeId: "B", mode: "bypassEverything" }]),
    ).toThrowError(/onError/);
  });

  it.each(["continueRegularOutput", "continueErrorOutput", "stopWorkflow"] as const)(
    "whitelisted mode %s is written to node.onError",
    (mode) => {
      const after = applyPatchOps(chain(), [{ op: "set_on_error", nodeId: "B", mode }]);
      const nodes = after.nodes as Node[];
      expect(nodes.find((node) => node.name === "B")).toMatchObject({ onError: mode });
      expect(nodes.find((node) => node.name === "A")).not.toHaveProperty("onError");
    },
  );

  it("set_on_error on a missing node is unknown path", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_on_error", nodeId: "Ghost", mode: "stopWorkflow" }]),
    ).toThrowError(/unknown path/);
  });
});

describe("acceptance: remove_node rewires A->B->C into A->C", () => {
  it("middle-node removal bypasses the removed node with consistent counts", () => {
    const after = applyPatchOps(chain(), [{ op: "remove_node", nodeId: "B" }]);
    expect((after.nodes as Node[]).map((node) => node.name).sort()).toEqual(["A", "C"]);
    const connections = after.connections as Record<string, unknown>;
    expect(Object.keys(connections).sort()).toEqual(["A"]);
    const edges = listEdges(connections);
    expect(edges).toEqual([
      { from: "A", type: "main", sourceIndex: 0, to: "C", targetIndex: 0 },
    ]);
    // Source/target counts consistent: one source key, one target total.
    const targetCount = edges.length;
    expect(Object.keys(connections)).toHaveLength(1);
    expect(targetCount).toBe(1);
  });

  it("removing a head node drops its outgoing key without inventing edges", () => {
    const after = applyPatchOps(chain(), [{ op: "remove_node", nodeId: "A" }]);
    expect((after.nodes as Node[]).map((node) => node.name).sort()).toEqual(["B", "C"]);
    expect(listEdges(after.connections)).toEqual([
      { from: "B", type: "main", sourceIndex: 0, to: "C", targetIndex: 0 },
    ]);
  });

  it("removing a missing node throws unknown path", () => {
    expect(() => applyPatchOps(chain(), [{ op: "remove_node", nodeId: "Ghost" }])).toThrowError(
      /unknown path/,
    );
  });
});

describe("acceptance: renames are disallowed outright", () => {
  it("set_parameter on nodes.Set1.name throws /rename/", () => {
    expect(() =>
      applyPatchOps(withParams("1"), [
        { op: "set_parameter", path: "nodes.Set1.name", value: "Renamed" },
      ]),
    ).toThrowError(PatchValidationError);
    expect(() =>
      applyPatchOps(withParams("1"), [
        { op: "set_parameter", path: "nodes.Set1.name", value: "Renamed" },
      ]),
    ).toThrowError(/rename/);
  });

  it("set_parameter on a node id leaf throws /rename/", () => {
    expect(() =>
      applyPatchOps(withParams("1"), [
        { op: "set_parameter", path: "nodes.Set1.id", value: "999" },
      ]),
    ).toThrowError(/rename/);
  });

  it("add_node addressing that disagrees with node.name throws /rename/", () => {
    expect(() =>
      applyPatchOps(chain(), [
        { op: "add_node", nodeId: "Other", node: named("New") } as unknown as Record<
          string,
          unknown
        >,
      ]),
    ).toThrowError(/rename/);
  });
});

describe("set_retry", () => {
  it("writes retryOnFail and retries on the addressed node only", () => {
    const after = applyPatchOps(chain(), [
      { op: "set_retry", nodeId: "B", retries: 3, retryOnFail: true },
    ]);
    const nodes = after.nodes as Node[];
    expect(nodes.find((node) => node.name === "B")).toMatchObject({
      retries: 3,
      retryOnFail: true,
    });
    expect(nodes.find((node) => node.name === "A")).not.toHaveProperty("retries");
  });

  it("unknown node -> unknown path", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_retry", nodeId: "Ghost", retries: 1, retryOnFail: true }]),
    ).toThrowError(/unknown path/);
  });

  it("negative retries and non-boolean retryOnFail -> invalid path format", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_retry", nodeId: "B", retries: -1, retryOnFail: true }]),
    ).toThrowError(/invalid path format/);
    expect(() =>
      applyPatchOps(chain(), [
        { op: "set_retry", nodeId: "B", retries: 1, retryOnFail: "yes" },
      ]),
    ).toThrowError(/invalid path format/);
  });
});

describe("add_node", () => {
  it("appends the node and splices it between connectFrom and connectTo", () => {
    const after = applyPatchOps(chain(), [
      { op: "add_node", node: named("New"), connectFrom: "A", connectTo: "C" },
    ]);
    expect((after.nodes as Node[]).map((node) => node.name).sort()).toEqual(["A", "B", "C", "New"]);
    const edges = listEdges(after.connections);
    expect(edges).toContainEqual({ from: "A", type: "main", sourceIndex: 0, to: "New", targetIndex: 0 });
    expect(edges).toContainEqual({ from: "New", type: "main", sourceIndex: 0, to: "C", targetIndex: 0 });
  });

  it("duplicate name throws containing 'duplicate'", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "add_node", node: named("A") }]),
    ).toThrowError(PatchValidationError);
    expect(() => applyPatchOps(chain(), [{ op: "add_node", node: named("A") }])).toThrowError(
      /duplicate/,
    );
  });

  it("connectFrom naming a missing node throws unknown path", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "add_node", node: named("New"), connectFrom: "Ghost" }]),
    ).toThrowError(/unknown path/);
  });
});

describe("op shape guards", () => {
  it("unknown op strings throw containing 'unknown op'", () => {
    expect(() => applyPatchOps(chain(), [{ op: "frobnicate" }])).toThrowError(PatchValidationError);
    expect(() => applyPatchOps(chain(), [{ op: "frobnicate" }])).toThrowError(/unknown op/);
  });

  it("malformed op objects throw containing 'unknown op'", () => {
    expect(() => applyPatchOps(chain(), [null])).toThrowError(/unknown op/);
    expect(() => applyPatchOps(chain(), [{ nope: true }])).toThrowError(/unknown op/);
  });

  it("non-array ops throws containing 'unknown op'", () => {
    expect(() => applyPatchOps(chain(), { op: "remove_node", nodeId: "B" })).toThrowError(
      /unknown op/,
    );
  });

  it("non-nodes.-prefixed paths throw invalid path format", () => {
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_parameter", path: "settings.x", value: 1 }]),
    ).toThrowError(/invalid path format/);
    expect(() =>
      applyPatchOps(chain(), [{ op: "set_parameter", path: "nodes.", value: 1 }]),
    ).toThrowError(/invalid path format/);
  });

  it("ops apply in order, so a later op can touch a node added earlier", () => {
    const after = applyPatchOps(chain(), [
      { op: "add_node", node: named("New") },
      { op: "set_parameter", path: "nodes.New.parameters", value: { v: 1 } },
    ]);
    expect((after.nodes as Node[]).find((node) => node.name === "New")).toMatchObject({
      parameters: { v: 1 },
    });
  });
});

describe("input is never mutated", () => {
  it("the input workflow and ops payloads are unchanged after success", () => {
    const before = chain();
    const snapshot = JSON.parse(JSON.stringify(before)) as Workflow;
    const ops = [{ op: "remove_node", nodeId: "B" }] as unknown[];
    const after = applyPatchOps(before, ops);
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });

  it("a throwing batch leaves the input untouched", () => {
    const before = chain();
    const snapshot = JSON.parse(JSON.stringify(before)) as Workflow;
    expect(() =>
      applyPatchOps(before, [
        { op: "set_parameter", path: "nodes.A.parameters", value: {} },
        { op: "set_parameter", path: "nodes.Ghost.parameters.x", value: 1 },
      ]),
    ).toThrowError(PatchValidationError);
    expect(before).toEqual(snapshot);
  });
});

describe("connections helpers", () => {
  it("listEdges flattens canonical connections and skips malformed slots", () => {
    expect(
      listEdges({
        A: { main: [[{ node: "B", index: 2 }], "junk", [{ node: "", index: 0 }]] },
        Broken: 42,
      }),
    ).toEqual([{ from: "A", type: "main", sourceIndex: 0, to: "B", targetIndex: 2 }]);
  });

  it("removeNodeRewire on a diamond does not duplicate the bypass edge", () => {
    const connections = {
      A: { main: [[{ node: "B", type: "main", index: 0 }], [{ node: "C", type: "main", index: 0 }]] },
      B: { main: [[{ node: "C", type: "main", index: 0 }]] },
    };
    const rewired = removeNodeRewire(connections, "B");
    const toC = listEdges(rewired).filter((edge) => edge.from === "A" && edge.to === "C");
    expect(toC).toHaveLength(2);
    expect(rewired).not.toHaveProperty("B");
  });

  it("insertNodeRewire splices a node in series between two connected nodes", () => {
    const rewired = insertNodeRewire(
      { A: { main: [[{ node: "C", type: "main", index: 0 }]] } },
      "New",
      "A",
      "C",
    );
    const edges = listEdges(rewired);
    expect(edges).toContainEqual({ from: "A", type: "main", sourceIndex: 0, to: "New", targetIndex: 0 });
    expect(edges).toContainEqual({ from: "New", type: "main", sourceIndex: 0, to: "C", targetIndex: 0 });
    expect(edges.some((edge) => edge.from === "A" && edge.to === "C")).toBe(false);
  });
});
