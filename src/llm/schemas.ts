/**
 * Pinned contract (issue #9): TypeBox verdict schemas for the `diagnose`,
 * `patch`, and `judge` stages, plus a never-throws `validate` helper built
 * on `Value.Errors`. `confidence` on the diagnose and judge schemas is a
 * number between 0 and 1. Every schema sets `additionalProperties: false`
 * so stray LLM keys fail validation instead of leaking downstream.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value, type ValueError } from "@sinclair/typebox/value";

/** Scenario strings the deterministic mock can emit; shared by all verdicts. */
export const SCENARIO_KINDS = ["schema-drift", "transient-429", "human-broke-it"] as const;

export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/** Diagnose verdict: what broke, where, why, and how sure the model is. */
export const diagnoseVerdictSchema = Type.Object(
  {
    rootCauseKind: Type.Union([
      Type.Literal("schema-drift"),
      Type.Literal("transient-429"),
      Type.Literal("human-broke-it"),
    ]),
    failureClass: Type.String(),
    affectedNodes: Type.Array(Type.String()),
    reasoning: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export type DiagnoseVerdict = Static<typeof diagnoseVerdictSchema>;

/** Contract alias: issue #11 prose calls the diagnose schema `diagnoseSchema`. */
export const diagnoseSchema = diagnoseVerdictSchema;

/** One path-level `set_parameter` edit; mirrors `SetParameterOp` in `src/patch/patchOps.ts`. */
const setParameterOpSchema = Type.Object(
  {
    op: Type.Literal("set_parameter"),
    path: Type.String(),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

/** Retry-count edit; mirrors `SetRetryOp` in `src/patch/patchOps.ts`. */
const setRetryOpSchema = Type.Object(
  {
    op: Type.Literal("set_retry"),
    nodeId: Type.String(),
    retries: Type.Integer({ minimum: 0 }),
    retryOnFail: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** onError-mode edit; the mode whitelist is enforced by `applyPatchOps`, not here. */
const setOnErrorOpSchema = Type.Object(
  {
    op: Type.Literal("set_on_error"),
    nodeId: Type.String(),
    mode: Type.String(),
  },
  { additionalProperties: false },
);

/** Node insertion; mirrors `AddNodeOp` in `src/patch/patchOps.ts`. */
const addNodeOpSchema = Type.Object(
  {
    op: Type.Literal("add_node"),
    node: Type.Record(Type.String(), Type.Unknown()),
    connectFrom: Type.Optional(Type.String()),
    connectTo: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Node removal; mirrors `RemoveNodeOp` in `src/patch/patchOps.ts`. */
const removeNodeOpSchema = Type.Object(
  {
    op: Type.Literal("remove_node"),
    nodeId: Type.String(),
  },
  { additionalProperties: false },
);

/** Patch verdict: scoped path-level ops plus the rationale carrying confidence. */
export const patchVerdictSchema = Type.Object(
  {
    ops: Type.Array(
      Type.Union([
        setParameterOpSchema,
        setRetryOpSchema,
        setOnErrorOpSchema,
        addNodeOpSchema,
        removeNodeOpSchema,
      ]),
    ),
    rationale: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export type PatchVerdict = Static<typeof patchVerdictSchema>;

/** Judge verdict: approve the patch, reject it, or escalate to a human. */
export const judgeVerdictSchema = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("escalate"),
    ]),
    reason: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export type JudgeVerdict = Static<typeof judgeVerdictSchema>;

/**
 * Run `value` through a TypeBox schema. Never throws: returns `ok:true`
 * with zero errors on success, otherwise `ok:false` with every collected
 * `ValueError`.
 */
export function validate(
  schema: TSchema,
  value: unknown,
): { ok: boolean; errors: ValueError[] } {
  const errors = [...Value.Errors(schema, value)];
  return { ok: errors.length === 0, errors };
}
