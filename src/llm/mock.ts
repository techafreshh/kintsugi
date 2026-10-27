/**
 * Pinned contract (issue #9): deterministic scenario-aware mock of
 * `LLMPort`. Reads `MOCK_LLM_SCENARIO` on every `submit_verdict` call
 * (constructor-injected env map defaulting to `process.env`, mirroring
 * `N8nClientConfig` in `src/n8n/client.ts`), normalizes blank/unknown to
 * `schema-drift`, and returns a fixed per-(scenario, stage) fixture whose
 * diagnose verdict sets `rootCauseKind` to the resolved scenario. Each
 * fixture runs through `validate` before return so a bad fixture throws
 * loudly instead of leaking.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { validate, type ScenarioKind } from "./schemas.js";
import type { LlmMode, LlmStage, LLMPort } from "./port.js";

export type MockScenario = ScenarioKind;

const SCENARIOS: readonly MockScenario[] = ["schema-drift", "transient-429", "human-broke-it"];

const DEFAULT_SCENARIO: MockScenario = "schema-drift";

export class MockLLM implements LLMPort {
  readonly name = "mock";
  readonly mode: LlmMode = "mock";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * Resolve the active scenario from the injected env. Trims whitespace,
   * falls through on blank/missing/unknown (mirroring `resolvePort`
   * blank-falls-through in `src/config/settings.ts`); never throws.
   */
  resolveScenario(): MockScenario {
    const raw = this.env.MOCK_LLM_SCENARIO;
    if (raw === undefined) return DEFAULT_SCENARIO;
    const trimmed = raw.trim();
    if (trimmed === "") return DEFAULT_SCENARIO;
    return (SCENARIOS as readonly string[]).includes(trimmed)
      ? (trimmed as MockScenario)
      : DEFAULT_SCENARIO;
  }

  async submit_verdict<T extends TSchema>(
    stage: LlmStage,
    _prompt: unknown,
    schema: T,
  ): Promise<Static<T>> {
    const scenario = this.resolveScenario();
    const fixture: unknown = buildFixture(scenario, stage);
    const result = validate(schema, fixture);
    if (!result.ok) {
      throw new Error(
        `mock LLM fixture for stage "${stage}" scenario "${scenario}" failed schema validation: ${describeErrors(result.errors)}`,
      );
    }
    return fixture as Static<T>;
  }
}

/** Fixed per-(scenario, stage) verdict; the diagnose kind tracks the scenario. */
function buildFixture(scenario: MockScenario, stage: LlmStage): unknown {
  switch (stage) {
    case "diagnose":
      return diagnoseFixture(scenario);
    case "patch":
      return patchFixture(scenario);
    case "judge":
      return judgeFixture(scenario);
  }
}

function diagnoseFixture(scenario: MockScenario): unknown {
  switch (scenario) {
    case "transient-429":
      return {
        rootCauseKind: "transient-429",
        failureClass: "transient upstream 429",
        affectedNodes: ["HttpRequest"],
        reasoning: "Upstream answered 429; the workflow shape is fine, retry with backoff.",
        confidence: 0.68,
      };
    case "human-broke-it":
      return {
        rootCauseKind: "human-broke-it",
        failureClass: "manual edit broke expression",
        affectedNodes: ["Set"],
        reasoning: "A hand edit left an expression referencing a renamed node; restore the reference.",
        confidence: 0.88,
      };
    case "schema-drift":
    default:
      return {
        rootCauseKind: "schema-drift",
        failureClass: "upstream schema change",
        affectedNodes: ["HttpRequest", "Set"],
        reasoning: "Upstream renamed a response field; the Set node still reads the old path.",
        confidence: 0.91,
      };
  }
}

function patchFixture(scenario: MockScenario): unknown {
  switch (scenario) {
    case "transient-429":
      return {
        ops: [],
        rationale: "Transient 429 needs no code change; back off and requeue.",
        confidence: 0.72,
      };
    case "human-broke-it":
      return {
        ops: [{ op: "set_parameter", path: "nodes.Set.parameters.value", value: "={{ $json.fixed }}" }],
        rationale: "Restore the expression the manual edit broke.",
        confidence: 0.84,
      };
    case "schema-drift":
    default:
      return {
        ops: [{ op: "set_parameter", path: "nodes.Set.parameters.value", value: "={{ $json.renamed }}" }],
        rationale: "Point the Set node at the renamed upstream field.",
        confidence: 0.9,
      };
  }
}

function judgeFixture(scenario: MockScenario): unknown {
  switch (scenario) {
    case "transient-429":
      return {
        verdict: "escalate",
        reason: "Transient 429: no patch to approve, requeue with backoff.",
        confidence: 0.66,
      };
    case "human-broke-it":
      return {
        verdict: "escalate",
        reason: "Manual breakage touches ownership; a human should confirm the restore.",
        confidence: 0.81,
      };
    case "schema-drift":
    default:
      return {
        verdict: "approve",
        reason: "Patch tracks the renamed field and matches the diagnosis.",
        confidence: 0.93,
      };
  }
}

function describeErrors(errors: Array<{ path: string; message: string }>): string {
  const first = errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`);
  return first.length > 0 ? first.join("; ") : "unknown validation error";
}
