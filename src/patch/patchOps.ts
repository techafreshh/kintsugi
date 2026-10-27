/**
 * Pinned contract (issue #8): validated path-level operation application.
 * The LLM never authors raw n8n JSON; it emits path-level ops and this module
 * applies them with strict validation, rewiring `connections` in code via
 * `src/patch/connections.ts`. The input workflow is never mutated — every
 * call works on a fresh deep clone and returns it. Any violation (unknown
 * path, non-whitelisted onError mode, node rename, invalid path format,
 * duplicate add, unknown op) throws the labeled `PatchValidationError`.
 */

import { insertNodeRewire, removeNodeRewire } from "./connections.js";

/**
 * Labeled error for every patch-ops violation, mirroring `N8nNotFoundError`
 * in `src/n8n/client.ts` (name set in the constructor, contextual message).
 */
export class PatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchValidationError";
  }
}

/** Whitelist for `set_on_error` modes; anything else is rejected. */
export const ON_ERROR_MODES = [
  "continueRegularOutput",
  "continueErrorOutput",
  "stopWorkflow",
] as const;

export type OnErrorMode = (typeof ON_ERROR_MODES)[number];

export interface SetParameterOp {
  op: "set_parameter";
  /** Dotted path, e.g. "nodes.Set1.parameters.value"; must already exist. */
  path: string;
  value: unknown;
}

export interface SetRetryOp {
  op: "set_retry";
  /** Node `name`, falling back to string `id` when present. */
  nodeId: string;
  retries: number;
  retryOnFail: boolean;
}

export interface SetOnErrorOp {
  op: "set_on_error";
  /** Node `name`, falling back to string `id` when present. */
  nodeId: string;
  mode: string;
}

export interface AddNodeOp {
  op: "add_node";
  node: Record<string, unknown>;
  connectFrom?: string;
  connectTo?: string;
}

export interface RemoveNodeOp {
  op: "remove_node";
  /** Node `name`, falling back to string `id` when present. */
  nodeId: string;
}

export type PatchOp =
  | SetParameterOp
  | SetRetryOp
  | SetOnErrorOp
  | AddNodeOp
  | RemoveNodeOp;

/**
 * Apply path-level ops to a workflow. Deep-clones the workflow up front
 * (`JSON.parse(JSON.stringify(...))` semantics with a structuredClone fallback
 * for non-JSON values), requires `ops` to be an array, then validates and
 * applies each op in order against the evolving clone. Throws
 * `PatchValidationError` on the first violation (the clone is discarded, so a
 * throw always means "nothing was returned"); otherwise returns the clone.
 */
export function applyPatchOps(workflow: unknown, ops: unknown): Record<string, unknown> {
  const root = deepClone(workflow);
  if (!isPlainObject(root)) {
    throw new PatchValidationError(
      `invalid path format: workflow must be an object, got ${describeValue(workflow)}`,
    );
  }
  if (!Array.isArray(ops)) {
    throw new PatchValidationError(`unknown op: ops must be an array, got ${describeValue(ops)}`);
  }
  ops.forEach((op, index) => applyOp(root, op, index));
  return root;
}

function applyOp(root: Record<string, unknown>, op: unknown, index: number): void {
  if (!isPlainObject(op) || typeof op.op !== "string") {
    throw new PatchValidationError(`unknown op at index ${index}: ${describeValue(op)}`);
  }
  switch (op.op) {
    case "set_parameter":
      applySetParameter(root, op);
      break;
    case "set_retry":
      applySetRetry(root, op);
      break;
    case "set_on_error":
      applySetOnError(root, op);
      break;
    case "add_node":
      applyAddNode(root, op);
      break;
    case "remove_node":
      applyRemoveNode(root, op);
      break;
    default:
      throw new PatchValidationError(`unknown op "${op.op}" at index ${index}`);
  }
}

/**
 * `set_parameter`: the full path must already exist (walk plain objects and
 * arrays, numeric segments index arrays); the leaf is replaced but no new key
 * or node is ever created. Any path whose target key is `name` or `id` is a
 * node rename and is disallowed outright.
 */
function applySetParameter(root: Record<string, unknown>, op: Record<string, unknown>): void {
  if (typeof op.path !== "string" || op.path === "") {
    throw new PatchValidationError(`invalid path format: set_parameter path must be a non-empty string`);
  }
  const { entry, rest } = resolveNodePath(root.nodes, op.path);
  const segments = rest.split(".");
  const leaf = segments[segments.length - 1];
  if (leaf === "name" || leaf === "id") {
    throw new PatchValidationError(`node rename is not allowed: ${op.path}`);
  }
  let current: unknown = entry;
  for (const segment of segments.slice(0, -1)) {
    current = childAt(current, segment);
    if (current === undefined) {
      throw new PatchValidationError(`unknown path: ${op.path}`);
    }
  }
  if (!hasChild(current, segments[segments.length - 1] as string)) {
    throw new PatchValidationError(`unknown path: ${op.path}`);
  }
  setChild(current, segments[segments.length - 1] as string, deepClone(op.value));
}

/** `set_retry`: writes top-level `retryOnFail` plus `retries` and the n8n-style `maxTries` alias on the node. */
function applySetRetry(root: Record<string, unknown>, op: Record<string, unknown>): void {
  if (typeof op.nodeId !== "string" || op.nodeId === "") {
    throw new PatchValidationError(
      `invalid path format: set_retry nodeId must be a non-empty string`,
    );
  }
  if (typeof op.retries !== "number" || !Number.isInteger(op.retries) || op.retries < 0) {
    throw new PatchValidationError(
      `invalid path format: set_retry retries must be a non-negative integer, got ${describeValue(op.retries)}`,
    );
  }
  if (typeof op.retryOnFail !== "boolean") {
    throw new PatchValidationError(
      `invalid path format: set_retry retryOnFail must be a boolean, got ${describeValue(op.retryOnFail)}`,
    );
  }
  const found = findNode(root.nodes, op.nodeId);
  if (found === null) {
    throw new PatchValidationError(`unknown path: node "${op.nodeId}" not found`);
  }
  found.entry.retryOnFail = op.retryOnFail;
  found.entry.retries = op.retries;
  found.entry.maxTries = op.retries;
}

/** `set_on_error`: mode must be in the `ON_ERROR_MODES` whitelist. */
function applySetOnError(root: Record<string, unknown>, op: Record<string, unknown>): void {
  if (typeof op.nodeId !== "string" || op.nodeId === "") {
    throw new PatchValidationError(
      `invalid path format: set_on_error nodeId must be a non-empty string`,
    );
  }
  if (typeof op.mode !== "string" || !(ON_ERROR_MODES as readonly string[]).includes(op.mode)) {
    throw new PatchValidationError(
      `invalid onError mode "${describeValue(op.mode)}": expected one of ${ON_ERROR_MODES.join(", ")}`,
    );
  }
  const found = findNode(root.nodes, op.nodeId);
  if (found === null) {
    throw new PatchValidationError(`unknown path: node "${op.nodeId}" not found`);
  }
  found.entry.onError = op.mode;
}

/**
 * `add_node`: appends a cloned copy of the payload node (creating the `nodes`
 * array when absent, or setting the map key for pre-keyed object maps), then
 * splices it into the connection graph when `connectFrom`/`connectTo` name
 * existing nodes. Duplicate names and any addressing that disagrees with
 * `node.name` (a rename) are rejected.
 */
function applyAddNode(root: Record<string, unknown>, op: Record<string, unknown>): void {
  if (!isPlainObject(op.node) || typeof op.node.name !== "string" || op.node.name === "") {
    throw new PatchValidationError(
      `invalid path format: add_node node must be an object with a non-empty string name`,
    );
  }
  const name = op.node.name;
  for (const key of ["nodeId", "name", "nodeName"] as const) {
    const addressing = op[key];
    if (typeof addressing === "string" && addressing !== "" && addressing !== name) {
      throw new PatchValidationError(`node rename is not allowed: add_node "${addressing}" !== node "${name}"`);
    }
  }
  if (findNode(root.nodes, name) !== null) {
    throw new PatchValidationError(`duplicate node name "${name}"`);
  }
  const connectFrom = optionalNodeRef(op.connectFrom, "add_node connectFrom");
  const connectTo = optionalNodeRef(op.connectTo, "add_node connectTo");
  if (connectFrom !== undefined && findNode(root.nodes, connectFrom) === null) {
    throw new PatchValidationError(`unknown path: node "${connectFrom}" not found`);
  }
  if (connectTo !== undefined && findNode(root.nodes, connectTo) === null) {
    throw new PatchValidationError(`unknown path: node "${connectTo}" not found`);
  }
  const fresh = deepClone(op.node);
  if (Array.isArray(root.nodes)) {
    root.nodes.push(fresh);
  } else if (isPlainObject(root.nodes)) {
    root.nodes[name] = fresh;
  } else {
    root.nodes = [fresh];
  }
  if (connectFrom !== undefined || connectTo !== undefined) {
    const base = isPlainObject(root.connections) ? root.connections : {};
    root.connections = insertNodeRewire(base, name, connectFrom, connectTo);
  }
}

/**
 * `remove_node`: splices the node out of `nodes`, then bypass-rewires
 * `connections` in code so a chain A->B->C becomes A->C.
 */
function applyRemoveNode(root: Record<string, unknown>, op: Record<string, unknown>): void {
  if (typeof op.nodeId !== "string" || op.nodeId === "") {
    throw new PatchValidationError(
      `invalid path format: remove_node nodeId must be a non-empty string`,
    );
  }
  const found = findNode(root.nodes, op.nodeId);
  if (found === null) {
    throw new PatchValidationError(`unknown path: node "${op.nodeId}" not found`);
  }
  const displayName =
    typeof found.entry.name === "string" && found.entry.name !== ""
      ? found.entry.name
      : found.mapKey;
  if (Array.isArray(root.nodes) && found.index !== undefined) {
    root.nodes.splice(found.index, 1);
  } else if (isPlainObject(root.nodes) && found.mapKey !== undefined) {
    delete root.nodes[found.mapKey];
  }
  if (typeof displayName === "string" && displayName !== "" && root.connections !== undefined) {
    root.connections = removeNodeRewire(root.connections, displayName);
  }
}

/** Absent (undefined/null) node refs stay absent; anything else must be a string. */
function optionalNodeRef(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new PatchValidationError(`unknown path: ${what} must name an existing node`);
  }
  return value;
}

interface FoundNode {
  entry: Record<string, unknown>;
  /** Array position when `nodes` is an array. */
  index?: number;
  /** Map key when `nodes` is a pre-keyed object map. */
  mapKey?: string;
}

/**
 * Dual-shape node lookup (array or pre-keyed object map, like `nodeEntries`
 * in `src/llm/workflowView.ts` and `nodesToMap` in
 * `src/diff/workflowDiff.ts`): matches `name` first, then a string `id`.
 */
function findNode(nodes: unknown, nodeId: string): FoundNode | null {
  if (Array.isArray(nodes)) {
    let fallback: FoundNode | null = null;
    for (let index = 0; index < nodes.length; index += 1) {
      const candidate = nodes[index];
      if (!isPlainObject(candidate)) continue;
      if (candidate.name === nodeId) return { entry: candidate, index };
      if (fallback === null && matchesId(candidate.id, nodeId)) {
        fallback = { entry: candidate, index };
      }
    }
    return fallback;
  }
  if (isPlainObject(nodes)) {
    let fallback: FoundNode | null = null;
    for (const [mapKey, candidate] of Object.entries(nodes)) {
      if (!isPlainObject(candidate)) continue;
      const name =
        typeof candidate.name === "string" && candidate.name !== "" ? candidate.name : mapKey;
      if (name === nodeId) return { entry: candidate, mapKey };
      if (fallback === null && matchesId(candidate.id, nodeId)) {
        fallback = { entry: candidate, mapKey };
      }
    }
    return fallback;
  }
  return null;
}

function matchesId(id: unknown, nodeId: string): boolean {
  return (typeof id === "string" || typeof id === "number") && String(id) === nodeId;
}

/**
 * Strip the `nodes.` prefix and longest-match an existing node name followed
 * by `.`, so verbatim names with spaces or dots (exactly as `diffWorkflows`
 * leaf paths emit them) resolve correctly. Non-`nodes.`-prefixed or
 * empty-remainder paths are an invalid path format; a prefix matching no
 * existing node is an unknown path.
 */
function resolveNodePath(
  nodes: unknown,
  path: string,
): { entry: Record<string, unknown>; rest: string } {
  if (!path.startsWith("nodes.")) {
    throw new PatchValidationError(`invalid path format: ${path}`);
  }
  const after = path.slice("nodes.".length);
  if (after === "") {
    throw new PatchValidationError(`invalid path format: ${path}`);
  }
  let best: { entry: Record<string, unknown>; rest: string; nameLength: number } | null = null;
  for (const candidate of nodeEntries(nodes)) {
    const name =
      typeof candidate.entry.name === "string" && candidate.entry.name !== ""
        ? candidate.entry.name
        : candidate.mapKey;
    if (typeof name !== "string" || name === "") continue;
    if (after === name || after.startsWith(`${name}.`)) {
      const rest = after === name ? "" : after.slice(name.length + 1);
      if (best === null || name.length > best.nameLength) {
        best = { entry: candidate.entry, rest, nameLength: name.length };
      }
    }
  }
  if (best === null) {
    throw new PatchValidationError(`unknown path: ${path}`);
  }
  if (best.rest === "") {
    throw new PatchValidationError(`invalid path format: ${path}`);
  }
  return best;
}

interface NodeEntry {
  entry: Record<string, unknown>;
  mapKey?: string;
}

/** One entry per plain-object node; array or pre-keyed object map, like the diff. */
function nodeEntries(nodes: unknown): NodeEntry[] {
  if (Array.isArray(nodes)) {
    return nodes.filter(isPlainObject).map((entry) => ({ entry }));
  }
  if (isPlainObject(nodes)) {
    return Object.entries(nodes).flatMap(([key, node]) =>
      isPlainObject(node) ? [{ mapKey: key, entry: node }] : [],
    );
  }
  return [];
}

/** Step one level down; undefined when the segment does not already exist. */
function childAt(current: unknown, segment: string): unknown {
  if (Array.isArray(current)) {
    const index = arrayIndex(segment);
    return index !== null && index < current.length ? current[index] : undefined;
  }
  if (isPlainObject(current)) {
    return Object.hasOwn(current, segment) ? current[segment] : undefined;
  }
  return undefined;
}

/** Whether the final leaf already exists (no new keys are ever created). */
function hasChild(parent: unknown, leaf: string): boolean {
  if (Array.isArray(parent)) {
    const index = arrayIndex(leaf);
    return index !== null && index < parent.length;
  }
  return isPlainObject(parent) && Object.hasOwn(parent, leaf);
}

function setChild(parent: unknown, leaf: string, value: unknown): void {
  if (Array.isArray(parent)) {
    parent[arrayIndex(leaf) as number] = value;
    return;
  }
  (parent as Record<string, unknown>)[leaf] = value;
}

/** Canonical numeric array index; leading-zero or non-numeric segments are not indices. */
function arrayIndex(segment: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : null;
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
