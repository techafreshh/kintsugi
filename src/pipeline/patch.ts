/**
 * Pinned contract (issue #12): the patch stage of the repair loop.
 * `runPatchStage` turns an LLM-emitted op list into applied workflow changes:
 * it fetches the patch plan (injected `getPlan` or an `LLMPort` patch
 * verdict), validates that every op is schema-valid and every targeted node
 * is inside the diagnose `affectedNodes` scope, then applies the ops
 * atomically via `applyPatchOps`. The function is pure over the caller's
 * workflow object — application runs on a JSON deep clone that is discarded
 * on failure, so the input is never mutated — and every rejection is a
 * `PatchValidationError` (scope failures carry the literal substring `scope`
 * in the message, with the machine-readable reason attached as
 * `error.reason`) instead of a patched workflow.
 */

import { applyPatchOps, PatchValidationError } from "../patch/patchOps.js";
import type { PatchOp } from "../patch/patchOps.js";
import { patchVerdictSchema } from "../llm/schemas.js";
import type { LLMPort } from "../llm/port.js";
import { redactWorkflow } from "../security/redact.js";

export { PatchValidationError };
export type { PatchOp };

/** Workflow payload, passed through verbatim: JSON in, JSON out. */
export type WorkflowJson = Record<string, unknown>;

/** One applied op: a deep clone of the corresponding input op. */
export type AppliedOp = Record<string, unknown>;

/** Patch plan as emitted by the LLM (or an injected test double). */
export interface PatchPlan {
  /** Path-level ops applied in order; every entry must satisfy `isPatchOp`. */
  ops: unknown;
  /** Nodes the plan touches; checked against the diagnose scope when present. */
  affectedNodes?: unknown;
  [key: string]: unknown;
}

/** Fetches the patch plan; sync or async, an object with `ops` or a bare ops array. */
export type PatchPlanProvider = () => unknown | Promise<unknown>;

/**
 * Applies validated ops to a workflow clone. May return the patched workflow
 * directly (like the real `applyPatchOps`) or a `{ workflow, appliedOps }`
 * pair (like injected test fakes); anything else is an application error.
 */
export type PatchApplier = (
  workflow: WorkflowJson,
  ops: unknown[],
) =>
  | WorkflowJson
  | { workflow: WorkflowJson; appliedOps: unknown[] }
  | Promise<WorkflowJson | { workflow: WorkflowJson; appliedOps: unknown[] }>;

/** Why the stage rejected a plan; attached as `reason` on the thrown error. */
export type PatchRejectReason = "scope" | "schema" | "apply";

/** Diagnose verdict shape the stage reads scope from (only `affectedNodes` is used). */
export interface PatchScopeSource {
  affectedNodes?: unknown;
  [key: string]: unknown;
}

export interface RunPatchStageInput {
  /** Seed workflow; never mutated, applied only via a deep clone. */
  workflow: unknown;
  /** Failing node name (prompt context only; never scope-checked itself). */
  failingNode?: unknown;
  /** Alias for `failingNode` (planner prose uses both spellings). */
  failingNodeName?: unknown;
  /** Diagnose scope: every op target must be exactly equal to one entry. */
  affectedNodes?: unknown;
  /** Alias for `affectedNodes`. */
  scope?: unknown;
  /** Diagnose verdict carrying `affectedNodes` when not passed directly. */
  diagnose?: PatchScopeSource | null | undefined;
  /** Injected plan (object with `ops`, or a bare ops array). */
  plan?: unknown;
  /** Injected ops (shorthand for `plan: { ops }`). */
  ops?: unknown;
  /** Injected plan provider (sync or async). */
  getPlan?: PatchPlanProvider | null | undefined;
  /** Alias for `getPlan`. */
  planProvider?: PatchPlanProvider | null | undefined;
  /** Injected applier; defaults to the real `applyPatchOps`. */
  applyOps?: PatchApplier | null | undefined;
  /** Alias for `applyOps`. */
  applier?: PatchApplier | null | undefined;
  /** LLM behind the `patch` stage; used only when no plan is injected. */
  llm?: LLMPort | null | undefined;
  /** Prompt override for the `llm` call (a redacted-workflow prompt by default). */
  prompt?: unknown;
}

export interface RunPatchStageResult {
  /** Patched workflow clone; the input object is never returned. */
  workflow: WorkflowJson;
  /** One entry per input op, in input order. */
  appliedOps: AppliedOp[];
}

/** Default applier: the real validated path-level application from issue #8. */
const defaultApplier: PatchApplier = (workflow, ops) => applyPatchOps(workflow, ops);

/**
 * Run the patch stage: fetch the plan, validate op schemas, enforce the
 * affected-nodes scope, then apply atomically on a deep clone. Resolves with
 * the patched workflow plus one `appliedOps` entry per input op; rejects with
 * `PatchValidationError` (never a partial workflow) on any scope, schema, or
 * application failure, leaving the input workflow untouched.
 */
export async function runPatchStage(
  inputOrWorkflow: RunPatchStageInput | unknown,
  ...rest: unknown[]
): Promise<RunPatchStageResult> {
  const input = normalizeInput(inputOrWorkflow, rest);
  const plan = await fetchPlan(input);
  const ops = assertValidPlan(plan);
  const scope = takeScope(scopeSources(input, plan));
  if (scope !== undefined) assertScope(ops, input.workflow, scope);
  const clone = deepClone(input.workflow);
  const applier = input.applyOps ?? input.applier ?? defaultApplier;
  let applied: unknown;
  try {
    applied = await applier(clone as WorkflowJson, ops);
  } catch (cause) {
    throw wrapApplyError(cause);
  }
  return splitApplierResult(applied, ops);
}

/**
 * Accept the documented object input plus the common positional shapes
 * `(workflow, options)` and `(workflow, failingNode, scope, planSource,
 * applier)`, so LLM-wired and injection-wired callers share one entry point.
 * Unrecognized shapes fall through and fail later as typed schema errors,
 * never as raw TypeErrors.
 */
function normalizeInput(first: unknown, rest: unknown[]): RunPatchStageInput {
  if (rest.length === 0) {
    if (isPlainObject(first) && Object.hasOwn(first, "workflow")) {
      return first as unknown as RunPatchStageInput;
    }
    return { workflow: first };
  }
  if (rest.length === 1 && isPlainObject(rest[0]) && !isLLM(rest[0])) {
    return { ...(rest[0] as unknown as RunPatchStageInput), workflow: first };
  }
  const input: RunPatchStageInput = { workflow: first };
  const [second, third, fourth, fifth] = rest;
  absorbPositional(input, second, true);
  absorbPositional(input, third, false);
  absorbPositional(input, fourth, false);
  if (typeof fifth === "function") {
    input.applyOps ??= fifth as unknown as PatchApplier;
  } else {
    absorbPositional(input, fifth, false);
  }
  return input;
}

/** Fold one positional argument into the input: strings name nodes, arrays
 * name the scope (then the ops), functions are providers (then appliers). */
function absorbPositional(
  input: RunPatchStageInput,
  value: unknown,
  canBeFailingNode: boolean,
): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (canBeFailingNode && input.failingNode === undefined && input.failingNodeName === undefined) {
      input.failingNode = value;
    } else if (input.affectedNodes === undefined && input.scope === undefined) {
      input.affectedNodes = [value];
    }
    return;
  }
  if (Array.isArray(value)) {
    if (input.affectedNodes === undefined && input.scope === undefined) {
      input.affectedNodes = value;
    } else if (
      input.plan === undefined &&
      input.ops === undefined &&
      input.getPlan === undefined &&
      input.planProvider === undefined
    ) {
      input.ops = value;
    }
    return;
  }
  if (isLLM(value)) {
    input.llm ??= value;
    return;
  }
  if (typeof value === "function") {
    absorbFunction(input, value as unknown as (...args: never[]) => unknown);
    return;
  }
  if (isPlainObject(value)) {
    if (Object.hasOwn(value, "ops")) {
      input.plan ??= value;
    } else if (
      Object.hasOwn(value, "affectedNodes") &&
      (Object.hasOwn(value, "rootCauseKind") || Object.hasOwn(value, "failureClass"))
    ) {
      input.diagnose ??= value as PatchScopeSource;
    } else {
      Object.assign(input, value);
    }
  }
}

/** Two-declared-parameter functions are appliers, shorter ones are providers. */
function absorbFunction(
  input: RunPatchStageInput,
  fn: (...args: never[]) => unknown,
): void {
  if (fn.length >= 2) {
    input.applyOps ??= fn as unknown as PatchApplier;
    return;
  }
  if (
    input.getPlan === undefined &&
    input.planProvider === undefined &&
    input.plan === undefined &&
    input.ops === undefined
  ) {
    input.getPlan = fn as unknown as PatchPlanProvider;
  } else {
    input.applyOps ??= fn as unknown as PatchApplier;
  }
}

/** Fetch the plan from the injected provider, value, or the LLM's patch verdict. */
async function fetchPlan(input: RunPatchStageInput): Promise<unknown> {
  const provider = input.getPlan ?? input.planProvider;
  if (provider !== undefined && provider !== null) {
    try {
      return await provider();
    } catch (cause) {
      throw patchError(
        "schema",
        `patch: schema violation: plan provider threw: ${describeValue(cause)}`,
      );
    }
  }
  if (input.plan !== undefined) return input.plan;
  if (input.ops !== undefined) return input.ops;
  const llm = input.llm;
  if (llm !== undefined && llm !== null) {
    const prompt =
      input.prompt ??
      ({
        failingNode: failingName(input),
        affectedNodes: takeScope(scopeSources(input, undefined)) ?? [],
        workflow: redactWorkflow(input.workflow),
      } as const);
    try {
      return await llm.submit_verdict("patch", prompt, patchVerdictSchema);
    } catch (cause) {
      if (cause instanceof PatchValidationError) throw cause;
      throw patchError(
        "schema",
        `patch: schema violation: patch plan request failed: ${describeValue(cause)}`,
      );
    }
  }
  throw patchError(
    "schema",
    "patch: schema violation: no patch plan source (provide getPlan, plan, ops, or llm)",
  );
}

/**
 * Validate the plan shape and every op schema. Accepts a bare ops array or an
 * object with an `ops` array; returns the narrowed ops. Throws
 * `PatchValidationError` (reason `schema`) carrying the op index otherwise.
 */
export function assertValidPlan(plan: unknown): PatchOp[] {
  const ops: unknown =
    Array.isArray(plan) ? plan : isPlainObject(plan) && Array.isArray(plan.ops) ? plan.ops : null;
  if (ops === null) {
    throw patchError(
      "schema",
      `patch: schema violation: plan must be an ops array or an object with an ops array, got ${describeValue(plan)}`,
    );
  }
  const valid: PatchOp[] = [];
  (ops as unknown[]).forEach((op, index) => {
    if (!isPatchOp(op)) {
      throw patchError(
        "schema",
        `patch: schema violation: invalid op at index ${index}: ${describeValue(op)}`,
      );
    }
    valid.push(op);
  });
  return valid;
}

/**
 * Schema guard for one path-level op, mirroring the `SetParameterOp` family
 * in `src/patch/patchOps.ts` and the TypeBox op schemas in
 * `src/llm/schemas.ts`. The onError whitelist is the applier's job, so any
 * non-empty mode string passes here.
 */
export function isPatchOp(op: unknown): op is PatchOp {
  if (!isPlainObject(op) || typeof op.op !== "string") return false;
  switch (op.op) {
    case "set_parameter":
      return typeof op.path === "string" && op.path !== "" && Object.hasOwn(op, "value");
    case "set_retry":
      return (
        typeof op.nodeId === "string" &&
        op.nodeId !== "" &&
        typeof op.retries === "number" &&
        Number.isInteger(op.retries) &&
        op.retries >= 0 &&
        typeof op.retryOnFail === "boolean"
      );
    case "set_on_error":
      return (
        typeof op.nodeId === "string" &&
        op.nodeId !== "" &&
        typeof op.mode === "string" &&
        op.mode !== ""
      );
    case "add_node":
      return (
        isPlainObject(op.node) &&
        typeof op.node.name === "string" &&
        op.node.name !== "" &&
        (op.connectFrom === undefined ||
          op.connectFrom === null ||
          typeof op.connectFrom === "string") &&
        (op.connectTo === undefined || op.connectTo === null || typeof op.connectTo === "string")
      );
    case "remove_node":
      return typeof op.nodeId === "string" && op.nodeId !== "";
    default:
      return false;
  }
}

/** Scope candidates in precedence order: explicit input, then plan, then diagnose. */
function scopeSources(input: RunPatchStageInput, plan: unknown): unknown[] {
  const sources: unknown[] = [input.affectedNodes, input.scope];
  if (isPlainObject(plan)) sources.push(plan.affectedNodes);
  if (isPlainObject(input.diagnose)) sources.push(input.diagnose.affectedNodes);
  return sources;
}

/**
 * Resolve the scope to the first defined candidate. Arrays keep their string
 * entries, a bare string becomes a singleton, and anything else defined is a
 * schema error. `undefined` means no scope was given anywhere, so the caller
 * opted out of scope enforcement.
 */
function takeScope(sources: unknown[]): string[] | undefined {
  for (const source of sources) {
    if (source === undefined) continue;
    if (typeof source === "string") return source === "" ? [] : [source];
    if (Array.isArray(source)) {
      return source.filter((entry): entry is string => typeof entry === "string");
    }
    throw patchError(
      "schema",
      `patch: schema violation: affectedNodes must be an array of strings, got ${describeValue(source)}`,
    );
  }
  return undefined;
}

/** Reject every op whose targeted node is not exactly equal to a scope entry. */
function assertScope(ops: PatchOp[], workflow: unknown, scope: string[]): void {
  const scopeSet = new Set(scope);
  const candidates = [...scope, ...workflowNodeNames(workflow)];
  ops.forEach((op, index) => {
    for (const name of scopeNamesForOp(op, candidates)) {
      if (!scopeSet.has(name)) {
        throw patchError(
          "scope",
          `patch: scope violation: op at index ${index} targets node ${JSON.stringify(name)} outside the affected-nodes scope ${JSON.stringify(scope)}`,
        );
      }
    }
  });
}

/**
 * Existing-node names one op touches, for scope enforcement. `set_parameter`
 * paths resolve against the workflow's node names (longest match, like the
 * applier) with the scope entries as extra candidates so verbatim names with
 * spaces or dots match; unresolvable paths yield no names and surface later
 * as application errors. `add_node` checks only its `connectFrom`/`connectTo`
 * anchors — the new `node.name` is created, not affected.
 */
function scopeNamesForOp(op: PatchOp, candidates: string[]): string[] {
  const record = op as unknown as Record<string, unknown>;
  if (typeof record.node === "string" && record.node !== "") return [record.node];
  switch (record.op) {
    case "set_parameter": {
      if (typeof record.path !== "string") return [];
      const name = extractNodeNameFromPath(record.path, candidates);
      return name === null ? [] : [name];
    }
    case "set_retry":
    case "set_on_error":
    case "remove_node":
      return typeof record.nodeId === "string" && record.nodeId !== "" ? [record.nodeId] : [];
    case "add_node": {
      const names: string[] = [];
      if (typeof record.connectFrom === "string" && record.connectFrom !== "") {
        names.push(record.connectFrom);
      }
      if (typeof record.connectTo === "string" && record.connectTo !== "") {
        names.push(record.connectTo);
      }
      return names;
    }
    default:
      return [];
  }
}

/** Strip the `nodes.` prefix and longest-match a candidate name plus `.`,
 * falling back to the first path segment so out-of-scope unknown nodes still
 * fail scope instead of slipping through to the applier. */
function extractNodeNameFromPath(path: string, candidates: string[]): string | null {
  if (!path.startsWith("nodes.")) return null;
  const after = path.slice("nodes.".length);
  if (after === "") return null;
  let best: string | null = null;
  for (const name of candidates) {
    if (name === "") continue;
    if (after === name || after.startsWith(`${name}.`)) {
      if (best === null || name.length > best.length) best = name;
    }
  }
  if (best !== null) return best;
  const dot = after.indexOf(".");
  const fallback = dot === -1 ? after : after.slice(0, dot);
  return fallback === "" ? null : fallback;
}

/** Node names keyed by exact `name` (array or pre-keyed object map, like the diff). */
function workflowNodeNames(workflow: unknown): string[] {
  if (!isPlainObject(workflow)) return [];
  const nodes = workflow.nodes;
  const names: string[] = [];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (isPlainObject(node) && typeof node.name === "string" && node.name !== "") {
        names.push(node.name);
      }
    }
  } else if (isPlainObject(nodes)) {
    for (const [key, node] of Object.entries(nodes)) {
      if (!isPlainObject(node)) continue;
      if (typeof node.name === "string" && node.name !== "") names.push(node.name);
      else if (key !== "") names.push(key);
    }
  }
  return names;
}

/** Split the applier's return into the patched workflow plus per-op entries:
 * a `{ workflow, appliedOps }` pair is used as-is, a bare workflow record
 * gets one synthesized entry per input op. Anything else is an apply error. */
function splitApplierResult(applied: unknown, ops: PatchOp[]): RunPatchStageResult {
  if (
    isPlainObject(applied) &&
    !Object.hasOwn(applied, "nodes") &&
    isPlainObject(applied.workflow) &&
    Array.isArray(applied.appliedOps)
  ) {
    return {
      workflow: applied.workflow,
      appliedOps: (applied.appliedOps as unknown[]).map(
        (entry) => deepClone(entry) as unknown as AppliedOp,
      ),
    };
  }
  if (isPlainObject(applied)) {
    return {
      workflow: applied,
      appliedOps: ops.map((op) => deepClone(op) as unknown as AppliedOp),
    };
  }
  throw patchError(
    "apply",
    `patch: apply failed: applier returned an unusable result: ${describeValue(applied)}`,
  );
}

/** Rewrap any applier throw as `PatchValidationError`, preserving the
 * applier's own labeled message (unknown path, onError, rename, duplicate). */
function wrapApplyError(cause: unknown): PatchValidationError {
  if (cause instanceof PatchValidationError) {
    const tagged = cause as unknown as { reason?: PatchRejectReason };
    tagged.reason ??= "apply";
    return cause;
  }
  const message = cause instanceof Error && cause.message !== "" ? cause.message : describeValue(cause);
  return patchError("apply", `patch: apply failed: ${message}`);
}

/** Build a labeled stage error with the machine-readable rejection reason attached. */
function patchError(reason: PatchRejectReason, message: string): PatchValidationError {
  const error = new PatchValidationError(message);
  (error as unknown as { reason: PatchRejectReason }).reason = reason;
  return error;
}

/** Read the stage's rejection reason from a caught error, if it carries one. */
export function getPatchRejectReason(error: unknown): PatchRejectReason | undefined {
  if (error instanceof PatchValidationError) {
    const reason = (error as unknown as { reason?: unknown }).reason;
    return reason === "scope" || reason === "schema" || reason === "apply" ? reason : undefined;
  }
  return undefined;
}

function failingName(input: RunPatchStageInput): string {
  if (typeof input.failingNode === "string") return input.failingNode;
  if (typeof input.failingNodeName === "string") return input.failingNodeName;
  return "";
}

function isLLM(value: unknown): value is LLMPort {
  return isPlainObject(value) && typeof value.submit_verdict === "function";
}

function deepClone<T>(value: T): T {
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return JSON.parse(text) as T;
  } catch {
    // Non-JSON values (circular, BigInt) fall through to structuredClone.
  }
  return structuredClone(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? typeof value : text.slice(0, 120);
  } catch {
    return typeof value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
