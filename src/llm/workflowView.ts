/**
 * Pinned contract (issue #7): buildWorkflowView(rawWorkflow, runData,
 * lastGoodWorkflow?) translates raw n8n JSON into one compact, sanitized
 * object for LLM prompt binding — node list, edge list, failing-node detail,
 * trigger payload, and the last-known-good diff. `redactWorkflow` (issue #4)
 * runs on every input first so credential blocks are dropped before the view
 * is built; every string leaving this module goes through
 * truncate(redact(sanitize(text).text)), which closes the string-redaction
 * gap redactWorkflow deliberately leaves open. The function is pure over
 * untrusted data: never throws, never mutates its inputs, no HTTP surface.
 */

import { sanitize } from "../security/sanitize.js";
import { redact, redactWorkflow } from "../security/redact.js";
import { diffWorkflows, type WorkflowDiff } from "../diff/workflowDiff.js";

/** One workflow node in the view, one entry per plain-object node entry. */
export interface WorkflowViewNode {
  /** Stable view id: non-empty string `id` when present, else the name, else "". */
  id: string;
  /** Node display name (the identity connections and diffs key on); "" when absent. */
  name: string;
  /** Node type string, e.g. "n8n-nodes-base.httpRequest"; "" when absent. */
  type: string;
  /** Sanitized and truncated copy of the node's parameters; {} when absent. */
  parameters: unknown;
}

/** One flattened connection, source-insertion order preserved. */
export interface WorkflowViewEdge {
  /** Name of the source node (key in rawWorkflow.connections). */
  from: string;
  /** Name of the target node (the connection's `node` field). */
  to: string;
  /** Connection type key, e.g. "main". */
  type: string;
  /** Index into the source node's outputs array. */
  sourceIndex: number;
  /** The target's `index` field (0 when absent or not a number). */
  targetIndex: number;
}

/** The failing node with its run-captured error and input data. */
export interface WorkflowViewFailingNode {
  /** Node name resolved from runData; "" when unresolvable (theoretical). */
  name: string;
  /** Node type looked up by exact name in the workflow; "" when absent. */
  type: string;
  /** Redacted error text (message | description | stringified), null when none. */
  error: string | null;
  /** Sanitized copy of the run-data entry's `data`; null when not captured. */
  inputData: unknown;
}

/** The compact sanitized workflow view; nulls mark "not resolvable". */
export interface WorkflowView {
  nodes: WorkflowViewNode[];
  edges: WorkflowViewEdge[];
  failingNode: WorkflowViewFailingNode | null;
  triggerPayload: unknown;
  /** Diff from lastGoodWorkflow to rawWorkflow (issue #5 direction), null when no snapshot. */
  lastKnownGoodDiff: WorkflowDiff | null;
}

/** String-length cap per untrusted string; longer values get an ellipsis. */
const MAX_STRING_CHARS = 200;
/** Array-item cap inside sanitized structures. */
const MAX_ARRAY_ITEMS = 10;
/** Nesting cap inside sanitized structures; deeper containers collapse. Set
 * above 3 so real n8n task data (data.main[0][0].json.<fields>, payload
 * fields at depth 5) survives intact while runaway nesting stays bounded. */
const MAX_DEPTH = 8;

/**
 * Build the compact sanitized workflow view. Tolerant of arbitrary untrusted
 * shapes: malformed workflows yield empty lists, missing run data yields
 * nulls — the function never throws.
 */
export function buildWorkflowView(
  rawWorkflow: unknown,
  runData: unknown,
  lastGoodWorkflow?: unknown,
): WorkflowView {
  // Credential blocks are dropped before anything else reads the inputs.
  const workflow = asRecord(redactWorkflow(rawWorkflow));
  const runDataRoot = asRecord(redactWorkflow(runData));
  const runDataMap = findRunDataMap(runDataRoot);

  const nodes = collectNodes(workflow.nodes);
  const entries = nodeEntries(workflow.nodes);
  const edges = flattenEdges(workflow.connections);
  // `lastGoodWorkflow === undefined` (including an explicit undefined third
  // argument) means "no last-good snapshot"; anything else is diffed as-is.
  const lastKnownGoodDiff =
    lastGoodWorkflow !== undefined ? buildDiff(asRecord(lastGoodWorkflow), workflow) : null;
  const failingNode = findFailingNode(runDataRoot, runDataMap, workflow);
  const triggerPayload = buildTriggerPayload(runDataRoot, runDataMap, nodes, entries, edges);

  return { nodes, edges, failingNode, triggerPayload, lastKnownGoodDiff };
}

/** Failing-node detection, three channels in order: first error-tagged
 * run-data entry, then the Error-Trigger execution shape, then the last
 * run-data entry (n8n fails at the last executed node). */
function findFailingNode(
  runDataRoot: Record<string, unknown>,
  runDataMap: Map<string, Record<string, unknown>[]> | null,
  workflow: Record<string, unknown>,
): WorkflowViewFailingNode | null {
  // Channel 1: first map entry (insertion order) with an error-tagged task.
  if (runDataMap !== null) {
    for (const [name, tasks] of runDataMap) {
      const hit = tasks.find((task) => Object.hasOwn(task, "error"));
      if (hit !== undefined) {
        return failingNodeView(name, hit.error, hit.data, workflow);
      }
    }
  }

  // Channel 2: Error-Trigger shape — execution.lastNodeExecuted plus an error
  // on that execution object or at the top level.
  const execution = isPlainObject(runDataRoot.execution) ? runDataRoot.execution : null;
  const execCandidates = execution !== null ? [execution, runDataRoot] : [runDataRoot];
  for (const exec of execCandidates) {
    const name = exec.lastNodeExecuted;
    if (typeof name === "string" && name !== "" && (Object.hasOwn(exec, "error") || Object.hasOwn(runDataRoot, "error"))) {
      const errorValue = pickDefined(
        firstTaskField(runDataMap, name, "error"),
        exec.error,
        runDataRoot.error,
      );
      const dataValue = firstTaskField(runDataMap, name, "data");
      return failingNodeView(name, errorValue, dataValue, workflow);
    }
  }

  // Channel 3: no error marker anywhere — the last usable run-data entry is
  // presumed failing, walking back so trailing unusable entries cannot hide it.
  if (runDataMap !== null) {
    const entries = [...runDataMap.entries()];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [name, tasks] = entries[i];
      const task = tasks[tasks.length - 1];
      if (task !== undefined) {
        return failingNodeView(name, task.error, task.data, workflow);
      }
    }
  }
  return null;
}

/** Shared shaping of a detected failure into the view's failingNode shape. */
function failingNodeView(
  name: unknown,
  errorValue: unknown,
  dataValue: unknown,
  workflow: Record<string, unknown>,
): WorkflowViewFailingNode {
  const nodeName = sanitizeText(name);
  return {
    name: nodeName,
    type: nodeTypeByName(workflow.nodes, nodeName),
    error: extractErrorText(errorValue),
    inputData: dataValue === undefined ? null : sanitizeDeep(dataValue),
  };
}

function nodeTypeByName(nodes: unknown, name: string): string {
  for (const node of nodeEntries(nodes)) {
    if (sanitizeText(node.entry.name) === name) {
      return sanitizeText(node.entry.type);
    }
  }
  return "";
}

/** First task's field for a node name; undefined when map/name/tasks absent. */
function firstTaskField(
  runDataMap: Map<string, Record<string, unknown>[]> | null,
  name: string,
  field: string,
): unknown {
  const tasks = runDataMap?.get(name);
  const task = tasks?.[0];
  return task?.[field];
}

/**
 * Trigger payload preference chain: input data of the first trigger-typed
 * node, else of the first node with no inbound edge, else the execution-level
 * `startData` object; null when none of the three resolve.
 */
function buildTriggerPayload(
  runDataRoot: Record<string, unknown>,
  runDataMap: Map<string, Record<string, unknown>[]> | null,
  nodes: WorkflowViewNode[],
  entries: NodeEntry[],
  edges: WorkflowViewEdge[],
): unknown {
  // `nodes[i]` and `entries[i]` come from the same guarded iteration in
  // buildWorkflowView; the raw (redacted, unsanitized) name is what the
  // run-data map is keyed on, so map lookups prefer it over the sanitized
  // view name (which can differ for names containing stripped characters).
  const rawNameOf = (i: number): string | undefined => {
    const node = entries[i]?.entry;
    const name = node?.name;
    return typeof name === "string" && name !== "" ? name : entries[i]?.mapKey;
  };
  const inputOf = (viewName: string, i: number): unknown => {
    const rawName = rawNameOf(i);
    for (const key of rawName !== undefined ? [rawName, viewName] : [viewName]) {
      const value = firstTaskField(runDataMap, key, "data");
      if (value !== undefined) return sanitizeDeep(value);
    }
    return undefined;
  };
  const triggerIndex = nodes.findIndex((node) => node.type.toLowerCase().includes("trigger"));
  if (triggerIndex !== -1) {
    const payload = inputOf(nodes[triggerIndex].name, triggerIndex);
    if (payload !== undefined) return payload;
  }
  const inbound = new Set(edges.map((edge) => edge.to));
  const headlessIndex = nodes.findIndex((node) => !inbound.has(node.name));
  if (headlessIndex !== -1) {
    const payload = inputOf(nodes[headlessIndex].name, headlessIndex);
    if (payload !== undefined) return payload;
  }
  for (const container of [asRecord(asRecord(runDataRoot.data).resultData), asRecord(runDataRoot.resultData), runDataRoot]) {
    if (isPlainObject(container.startData)) return sanitizeDeep(container.startData);
  }
  return null;
}

/**
 * Diff from the last-good snapshot to the current workflow (old→new, issue #5
 * direction). Node names and leaf paths stay verbatim so the later patch-ops
 * module can address them; diff values go through sanitizeDeep (undefined
 * preserved for keys absent on one side).
 */
function buildDiff(
  lastGoodWorkflow: Record<string, unknown>,
  workflow: Record<string, unknown>,
): WorkflowDiff {
  const diff = diffWorkflows(lastGoodWorkflow, workflow);
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.map((entry) => ({
      name: entry.name,
      leafPath: entry.leafPath,
      before: sanitizeDeep(entry.before),
      after: sanitizeDeep(entry.after),
    })),
    changedLineCount: diff.changedLineCount,
  };
}

/**
 * Locate the run-data map {nodeName: [task, ...]} in any of the accepted
 * shapes: full execution JSON (data.resultData.runData), bare resultData,
 * a top-level `runData` key, or the root itself being the map. Returns null
 * when none of the shapes yields a non-empty map.
 */
function findRunDataMap(root: Record<string, unknown>): Map<string, Record<string, unknown>[]> | null {
  const candidates = [
    asRecord(asRecord(root.data).resultData).runData,
    asRecord(root.resultData).runData,
    root.runData,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && Object.keys(candidate).length > 0) {
      return tasksMap(candidate);
    }
  }
  if (Object.keys(root).length > 0 && isTaskMap(root)) return tasksMap(root);
  return null;
}

/** Root is the map itself only when every value is an array (the non-empty
 * check happens at the call site); per-name content checks live in tasksMap. */
function isTaskMap(root: Record<string, unknown>): boolean {
  return Object.values(root).every((value) => Array.isArray(value));
}

/** Name → usable tasks array; unusable names get an empty list, order preserved. */
function tasksMap(map: Record<string, unknown>): Map<string, Record<string, unknown>[]> {
  const result = new Map<string, Record<string, unknown>[]>();
  for (const [name, value] of Object.entries(map)) {
    const list = Array.isArray(value) ? value : isPlainObject(value) ? [value] : [];
    result.set(name, list.filter(isPlainObject));
  }
  return result;
}

/** One entry per plain-object node; array or pre-keyed object map, like the diff. */
function collectNodes(nodes: unknown): WorkflowViewNode[] {
  return nodeEntries(nodes).map((entry) => {
    const name = sanitizeText(entry.entry.name) || (entry.mapKey ? sanitizeText(entry.mapKey) : "");
    return {
      id: idOf(entry.entry, name),
      name,
      type: sanitizeText(entry.entry.type),
      parameters: entry.entry.parameters === undefined ? {} : sanitizeDeep(entry.entry.parameters),
    };
  });
}

interface NodeEntry {
  entry: Record<string, unknown>;
  /** Map key when nodes arrived as a pre-keyed object map, else undefined. */
  mapKey?: string;
}

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

/** View id: non-empty string `id` else the node name else "" (n8n has no stable
 * node id; connections and diff paths key on the name). */
function idOf(node: Record<string, unknown>, name: string): string {
  if (typeof node.id === "string" && node.id !== "") return sanitizeText(node.id);
  return name;
}

/** Flatten rawWorkflow.connections: connections[source][type][sourceIndex] = [{node, index}]. */
function flattenEdges(connections: unknown): WorkflowViewEdge[] {
  if (!isPlainObject(connections)) return [];
  const edges: WorkflowViewEdge[] = [];
  for (const [sourceName, byType] of Object.entries(connections)) {
    if (!isPlainObject(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, sourceIndex) => {
        if (!Array.isArray(targets)) return;
        for (const target of targets) {
          if (!isPlainObject(target) || typeof target.node !== "string" || target.node === "") continue;
          edges.push({
            from: sanitizeText(sourceName),
            to: sanitizeText(target.node),
            type: sanitizeText(type),
            sourceIndex,
            targetIndex: typeof target.index === "number" ? target.index : 0,
          });
        }
      });
    }
  }
  return edges;
}

/** Full string gate for every untrusted string leaving this module: sanitize
 * first (so invisible-char trickery collapses before pattern matching), then
 * redact (secret boundary), then truncate (never cuts a live secret). */
function sanitizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return truncateText(redact(sanitize(value).text));
}

function truncateText(text: string): string {
  return text.length <= MAX_STRING_CHARS ? text : `${text.slice(0, MAX_STRING_CHARS)}…`;
}

/** Redacted error text: message, else description, else stringified error. */
function extractErrorText(errorValue: unknown): string | null {
  if (typeof errorValue === "string") return emptyToNull(sanitizeText(errorValue));
  if (isPlainObject(errorValue)) {
    if (typeof errorValue.message === "string" && errorValue.message !== "") {
      return emptyToNull(sanitizeText(errorValue.message));
    }
    if (typeof errorValue.description === "string" && errorValue.description !== "") {
      return emptyToNull(sanitizeText(errorValue.description));
    }
  }
  try {
    const text = JSON.stringify(errorValue);
    return text === undefined ? null : emptyToNull(sanitizeText(text));
  } catch {
    // Circular or otherwise unserializable error values must not throw.
    return null;
  }
}

function emptyToNull(text: string): string | null {
  return text === "" ? null : text;
}

/**
 * Deep sanitize/truncate for untrusted structures (parameters, input data,
 * trigger payloads, diff values): every string through the full gate, arrays
 * capped at MAX_ARRAY_ITEMS, nesting capped at MAX_DEPTH (deeper containers
 * collapse to a "[truncated]" marker), non-plain objects pass through by
 * reference like redactWorkflow, and undefined survives (absent diff sides).
 */
function sanitizeDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDeep(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = sanitizeDeep(item, depth + 1);
    }
    return copy;
  }
  return value;
}

function pickDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
