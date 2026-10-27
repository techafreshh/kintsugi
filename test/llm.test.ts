import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createLLM } from "../src/llm/port.js";
import { MockLLM } from "../src/llm/mock.js";
import {
  diagnoseVerdictSchema,
  judgeVerdictSchema,
  patchVerdictSchema,
  validate,
  type DiagnoseVerdict,
} from "../src/llm/schemas.js";

const SCENARIOS = ["schema-drift", "transient-429", "human-broke-it"] as const;

function envFor(scenario: string | undefined): NodeJS.ProcessEnv {
  if (scenario === undefined) return {} as NodeJS.ProcessEnv;
  return { MOCK_LLM_SCENARIO: scenario } as NodeJS.ProcessEnv;
}

describe("mock diagnose verdict", () => {
  it('with MOCK_LLM_SCENARIO=schema-drift, submit_verdict("diagnose", ...) validates with zero errors and rootCauseKind === "schema-drift"', async () => {
    const llm = new MockLLM(envFor("schema-drift"));
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("schema-drift");
    const result = validate(diagnoseVerdictSchema, verdict);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('with MOCK_LLM_SCENARIO=transient-429, submit_verdict("diagnose", ...) validates with zero errors and rootCauseKind === "transient-429"', async () => {
    const llm = new MockLLM(envFor("transient-429"));
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("transient-429");
    const result = validate(diagnoseVerdictSchema, verdict);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('with MOCK_LLM_SCENARIO=human-broke-it, submit_verdict("diagnose", ...) validates with zero errors and rootCauseKind === "human-broke-it"', async () => {
    const llm = new MockLLM(envFor("human-broke-it"));
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("human-broke-it");
    const result = validate(diagnoseVerdictSchema, verdict);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("mock defaults", () => {
  it('with no scenario hint, the mock defaults to schema-drift and LLM.name === "mock" with mode === "mock"', async () => {
    const llm = createLLM(envFor(undefined));
    expect(llm.name).toBe("mock");
    expect(llm.mode).toBe("mock");
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("schema-drift");
    expect(validate(diagnoseVerdictSchema, verdict).ok).toBe(true);
  });

  it("with blank or unknown MOCK_LLM_SCENARIO, resolveScenario falls through to schema-drift without throwing", async () => {
    for (const hint of ["", "   ", "nope", "SCHEMA-DRIFT"]) {
      const llm = new MockLLM(envFor(hint));
      expect(llm.resolveScenario()).toBe("schema-drift");
      const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
      expect((verdict as DiagnoseVerdict).rootCauseKind).toBe("schema-drift");
    }
  });
});

describe("mock verdict validation", () => {
  it("for every scenario x stage, the verdict passes its TypeBox validator with zero errors", async () => {
    const schemas = {
      diagnose: diagnoseVerdictSchema,
      patch: patchVerdictSchema,
      judge: judgeVerdictSchema,
    } as const;
    for (const scenario of SCENARIOS) {
      const llm = new MockLLM(envFor(scenario));
      for (const stage of ["diagnose", "patch", "judge"] as const) {
        const verdict = await llm.submit_verdict(stage, { stage, scenario }, schemas[stage]);
        const result = validate(schemas[stage], verdict);
        expect(result.errors, `${scenario}/${stage} errors`).toHaveLength(0);
        expect(result.ok, `${scenario}/${stage} ok`).toBe(true);
      }
    }
  });

  it("reads MOCK_LLM_SCENARIO on every call, so a changed env map changes the verdict without restarting", async () => {
    const env = { MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv;
    const llm = new MockLLM(env);
    const first = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((first as DiagnoseVerdict).rootCauseKind).toBe("schema-drift");
    env.MOCK_LLM_SCENARIO = "human-broke-it";
    const second = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect((second as DiagnoseVerdict).rootCauseKind).toBe("human-broke-it");
  });
});

describe("verdict schemas", () => {
  it("diagnose and judge schemas expose a confidence property of type number with minimum 0 and maximum 1", () => {
    for (const schema of [diagnoseVerdictSchema, judgeVerdictSchema]) {
      const confidence = schema.properties.confidence as unknown as Record<string, unknown>;
      expect(confidence["type"]).toBe("number");
      expect(confidence["minimum"]).toBe(0);
      expect(confidence["maximum"]).toBe(1);
    }
  });

  it("diagnose and judge schemas reject confidence 2 via Value.Check while accepting confidence 0.5", () => {
    const diagnoseBase = {
      rootCauseKind: "schema-drift",
      failureClass: "schema",
      affectedNodes: ["Set"],
      reasoning: "r",
    };
    expect(Value.Check(diagnoseVerdictSchema, { ...diagnoseBase, confidence: 0.5 })).toBe(true);
    expect(Value.Check(diagnoseVerdictSchema, { ...diagnoseBase, confidence: 2 })).toBe(false);
    const judgeBase = { verdict: "approve", reason: "r" };
    expect(Value.Check(judgeVerdictSchema, { ...judgeBase, confidence: 0.5 })).toBe(true);
    expect(Value.Check(judgeVerdictSchema, { ...judgeBase, confidence: 2 })).toBe(false);
  });
});
