import { describe, expect, it } from "vitest";
import { applyPatchOps, PatchValidationError as PatchOpsValidationError } from "../src/patch/patchOps.js";
import { MockLLM } from "../src/llm/mock.js";
import {
  PatchValidationError,
  getPatchRejectReason,
  runPatchStage,
} from "../src/pipeline/patch.js";

type Node = Record<string, unknown>;
type Workflow = Record<string, unknown>;

const setNode = (name: string, parameters: Record<string, unknown>): Node => ({
  name,
  type: "n8n-nodes-base.set",
  position: [250, 300],
  parameters,
});

const seedLength1 = (): Workflow => ({
  nodes: [setNode("Length1", { mapping: "old" })],
  connections: {},
});

const snapshotOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const parameterOf = (workflow: Workflow, name: string, key: string): unknown => {
  const node = (workflow.nodes as Node[]).find((entry) => entry.name === name);
  return (node?.parameters as Record<string, unknown> | undefined)?.[key];
};

describe("acceptance: schema-drift patch applies the op with one appliedOp per op", () => {
  it("set_parameter on nodes.Length1.parameters.mapping is reflected with matching appliedOps", async () => {
    const workflow = seedLength1();
    const snapshot = snapshotOf(workflow);
    const result = await runPatchStage({
      workflow,
      failingNode: "Length1",
      affectedNodes: ["Length1"],
      getPlan: () => ({
        ops: [{ op: "set_parameter", path: "nodes.Length1.parameters.mapping", value: "new" }],
        affectedNodes: ["Length1"],
      }),
      applyOps: applyPatchOps,
    });
    expect(parameterOf(result.workflow, "Length1", "mapping")).toBe("new");
    expect(result.appliedOps).toHaveLength(1);
    expect(result.workflow).not.toBe(workflow);
    expect(workflow).toEqual(snapshot);
  });

  it("mock LLM scenario schema-drift drives the Set value fix through the default applier", async () => {
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const workflow: Workflow = {
      nodes: [setNode("Set", { value: "={{ $json.old }}" })],
      connections: {},
    };
    const result = await runPatchStage({
      workflow,
      failingNode: "Set",
      affectedNodes: ["HttpRequest", "Set"],
      llm,
    });
    expect(parameterOf(result.workflow, "Set", "value")).toBe("={{ $json.renamed }}");
    expect(result.appliedOps).toHaveLength(1);
  });
});

describe("acceptance: plan outside the affected-nodes scope is rejected", () => {
  it("op targeting Other while affectedNodes omits it throws a scope PatchValidationError with no workflow", async () => {
    const workflow: Workflow = {
      nodes: [setNode("Set", { value: "1" }), setNode("Other", { value: "2" })],
      connections: {},
    };
    const snapshot = snapshotOf(workflow);
    const input = {
      workflow,
      failingNode: "Set",
      affectedNodes: ["Set"],
      getPlan: () => ({
        ops: [{ op: "set_parameter", path: "nodes.Other.parameters.value", value: "x" }],
      }),
      applyOps: applyPatchOps,
    };
    let resolved: unknown;
    await runPatchStage(input).then(
      (result) => {
        resolved = result;
      },
      () => undefined,
    );
    expect(resolved).toBeUndefined();
    let caught: unknown;
    try {
      await runPatchStage(input);
      throw new Error("expected runPatchStage to reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PatchValidationError);
    expect(caught).toBeInstanceOf(PatchOpsValidationError);
    expect(PatchValidationError).toBe(PatchOpsValidationError);
    expect((caught as Error).message).toMatch(/scope/);
    expect(getPatchRejectReason(caught)).toBe("scope");
    expect(workflow).toEqual(snapshot);
  });
});

describe("acceptance: bad path rejects without partially modifying the input", () => {
  it("set_parameter on a nonexistent leaf throws PatchValidationError and leaves the input deep-equal", async () => {
    const workflow: Workflow = {
      nodes: [setNode("Set", { value: "1" })],
      connections: {},
    };
    const snapshot = snapshotOf(workflow);
    let caught: unknown;
    try {
      await runPatchStage({
        workflow,
        failingNode: "Set",
        affectedNodes: ["Set"],
        getPlan: () => ({
          ops: [{ op: "set_parameter", path: "nodes.Set.parameters.nonexistent", value: "x" }],
        }),
      });
      throw new Error("expected runPatchStage to reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PatchValidationError);
    expect(workflow).toEqual(snapshot);
  });

  it("a failing multi-op batch does not leave the first op applied on the original object", async () => {
    const workflow: Workflow = {
      nodes: [setNode("Length1", { mapping: "old" }), setNode("Set", { value: "1" })],
      connections: {},
    };
    const snapshot = snapshotOf(workflow);
    await expect(
      runPatchStage({
        workflow,
        failingNode: "Length1",
        affectedNodes: ["Length1", "Set"],
        getPlan: () => ({
          ops: [
            { op: "set_parameter", path: "nodes.Length1.parameters.mapping", value: "partial" },
            { op: "set_parameter", path: "nodes.Set.parameters.nonexistent", value: "x" },
          ],
        }),
      }),
    ).rejects.toThrowError(PatchValidationError);
    expect(workflow).toEqual(snapshot);
    expect(parameterOf(workflow, "Length1", "mapping")).toBe("old");
  });
});
