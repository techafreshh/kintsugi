/**
 * Node-level diff between two n8n workflow JSONs (issue #5). Nodes are keyed
 * by their string `name`; every other top-level field is diffed as a plain
 * record. Leaf primitives and arrays are indivisible: one unequal array is one
 * changed entry, so legitimate array reordering (position, connections.main)
 * can never inflate the count. changedLineCount is the single number tier
 * rules and patch review read: leaf changes + node additions + node removals.
 */

export interface WorkflowDiffEntry {
  /** Node name for `nodes.<Name>.*` changes, "" for top-level field changes. */
  name: string;
  /** Dotted path; node names appear verbatim (no escaping), e.g. "nodes.My HTTP Request.parameters.url". */
  leafPath: string;
  /** Raw value on the `before` side; undefined when the key exists only in `after`. */
  before: unknown;
  /** Raw value on the `after` side; undefined when the key exists only in `before`. */
  after: unknown;
}

export interface WorkflowDiff {
  added: Array<{ name: string }>;
  removed: Array<{ name: string }>;
  changed: WorkflowDiffEntry[];
  changedLineCount: number;
}

/**
 * Diff two workflow payloads. Never throws: non-object inputs are treated as
 * empty records, and node entries without a usable string `name` are skipped
 * (malformed `nodes` yields an empty map on that side).
 */
export function diffWorkflows(before: unknown, after: unknown): WorkflowDiff {
  const beforeRoot = asRecord(before);
  const afterRoot = asRecord(after);
  const beforeNodes = nodesToMap(beforeRoot.nodes);
  const afterNodes = nodesToMap(afterRoot.nodes);

  const added: Array<{ name: string }> = [];
  const removed: Array<{ name: string }> = [];
  const changed: WorkflowDiffEntry[] = [];

  for (const [name, node] of beforeNodes) {
    const counterpart = afterNodes.get(name);
    if (counterpart === undefined) removed.push({ name });
    else diffRecords(node, counterpart, name, `nodes.${name}`, changed);
  }
  for (const name of afterNodes.keys()) {
    if (!beforeNodes.has(name)) added.push({ name });
  }

  for (const key of unionKeys(beforeRoot, afterRoot)) {
    // `nodes` is handled by name above; diffing it as a blob would hide which node moved.
    if (key === "nodes") continue;
    diffValue(beforeRoot[key], afterRoot[key], "", key, changed);
  }

  // Deterministic output: identical input pairs produce byte-identical results
  // regardless of key order between the sources (n8n GET vs stored PUT).
  added.sort(byName);
  removed.sort(byName);
  changed.sort(byLeafPath);
  return {
    added,
    removed,
    changed,
    changedLineCount: added.length + removed.length + changed.length,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Node map keyed by name: an n8n `nodes` array is keyed by each entry's string
 * `name` (last occurrence wins); a pre-keyed object map is accepted as-is.
 */
function nodesToMap(nodes: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (!isPlainObject(node) || typeof node.name !== "string") continue;
      map.set(node.name, node);
    }
  } else if (isPlainObject(nodes)) {
    for (const [name, node] of Object.entries(nodes)) {
      if (isPlainObject(node)) map.set(name, node);
    }
  }
  return map;
}

/** `before` keys first, then `after`-only keys; final sorting hides this order. */
function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...Object.keys(a), ...Object.keys(b).filter((key) => !Object.hasOwn(a, key))];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  name: string,
  prefix: string,
  out: WorkflowDiffEntry[],
): void {
  for (const key of unionKeys(before, after)) {
    diffValue(before[key], after[key], name, `${prefix}.${key}`, out);
  }
}

function diffValue(
  before: unknown,
  after: unknown,
  name: string,
  path: string,
  out: WorkflowDiffEntry[],
): void {
  if (deepEqual(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of unionKeys(before, after)) {
      diffValue(before[key], after[key], name, `${path}.${key}`, out);
    }
    return;
  }
  // Arrays and primitives are leaves: one unequal value is one changed line.
  out.push({ name, leafPath: path, before, after });
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byLeafPath(a: WorkflowDiffEntry, b: WorkflowDiffEntry): number {
  return a.leafPath < b.leafPath ? -1 : a.leafPath > b.leafPath ? 1 : 0;
}
