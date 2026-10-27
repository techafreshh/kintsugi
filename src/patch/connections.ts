/**
 * Pinned contract (issue #8): pure connection-graph helpers for the patch-ops
 * layer. `connections` is the canonical n8n record
 * `connections[source][type][sourceIndex] = [{node, index}]`; every helper is
 * pure over untrusted JSON (never throws on malformed shapes, never mutates
 * its input) and returns a fresh deep-cloned record. Guard style mirrors
 * `flattenEdges` in `src/llm/workflowView.ts` (skip non-object `byType`,
 * non-array output slots, targets without a string `node`).
 */

/** One directed connection, source-insertion order preserved. */
export interface ConnectionEdge {
  /** Name of the source node (key in the connections record). */
  from: string;
  /** Connection type key, e.g. "main". */
  type: string;
  /** Index into the source node's outputs array. */
  sourceIndex: number;
  /** Name of the target node (the connection's `node` field). */
  to: string;
  /** The target's `index` field (0 when absent or not a number). */
  targetIndex: number;
}

/**
 * List every edge in a connections record. Tolerant of arbitrary shapes:
 * malformed input yields an empty list.
 */
export function listEdges(connections: unknown): ConnectionEdge[] {
  if (!isPlainObject(connections)) return [];
  const edges: ConnectionEdge[] = [];
  for (const [sourceName, byType] of Object.entries(connections)) {
    if (!isPlainObject(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, sourceIndex) => {
        if (!Array.isArray(targets)) return;
        for (const target of targets) {
          if (!isPlainObject(target) || typeof target.node !== "string" || target.node === "") continue;
          edges.push({
            from: sourceName,
            type,
            sourceIndex,
            to: target.node,
            targetIndex: typeof target.index === "number" ? target.index : 0,
          });
        }
      });
    }
  }
  return edges;
}

/**
 * Remove a node from the connection graph, bypass-rewiring its predecessors
 * to its successors in code: for every (predecessor -> removed) x
 * (removed -> successor) pair, a predecessor -> successor edge is added that
 * keeps the incoming edge's `type`/`sourceIndex` (the predecessor's output)
 * and the outgoing edge's `targetIndex` (the successor's input). Exact
 * duplicates (same node + index already present in the slot) are skipped, so
 * diamond shapes do not fan out. Self-loops through the removed node are
 * dropped silently.
 */
export function removeNodeRewire(
  connections: unknown,
  removedName: string,
): Record<string, unknown> {
  const record = cloneConnections(connections);
  const incoming = listEdges(record).filter(
    (edge) => edge.to === removedName && edge.from !== removedName,
  );
  const outgoing = listEdges(record).filter(
    (edge) => edge.from === removedName && edge.to !== removedName,
  );
  delete record[removedName];
  stripTargets(record, removedName);
  for (const inc of incoming) {
    for (const out of outgoing) {
      addEdge(record, inc.from, inc.type, inc.sourceIndex, out.to, out.targetIndex);
    }
  }
  return record;
}

/**
 * Splice a new node into the connection graph: adds `connectFrom -> nodeName`
 * and `nodeName -> connectTo` edges (type "main", slot 0, index 0 each),
 * creating the source keys as needed. When both ends are given and a direct
 * `connectFrom -> connectTo` edge already exists, that edge is dropped first
 * so the new node sits in series instead of in parallel. Absent (undefined or
 * null) ends are skipped; empty-string ends are skipped as well.
 */
export function insertNodeRewire(
  connections: unknown,
  nodeName: string,
  connectFrom?: string,
  connectTo?: string,
): Record<string, unknown> {
  const record = cloneConnections(connections);
  const from = typeof connectFrom === "string" && connectFrom !== "" ? connectFrom : undefined;
  const to = typeof connectTo === "string" && connectTo !== "" ? connectTo : undefined;
  if (from !== undefined && to !== undefined && from !== nodeName && to !== nodeName) {
    stripDirectEdge(record, from, to);
  }
  if (from !== undefined) addEdge(record, from, "main", 0, nodeName, 0);
  if (to !== undefined) addEdge(record, nodeName, "main", 0, to, 0);
  return record;
}

/** Deep-clone a connections record; malformed input becomes an empty record. */
function cloneConnections(connections: unknown): Record<string, unknown> {
  const clone = deepClone(connections);
  return isPlainObject(clone) ? clone : {};
}

/** Remove every target pointing at `name` from all slots; empty slots stay so
 * source-index alignment is preserved. */
function stripTargets(record: Record<string, unknown>, name: string): void {
  for (const byType of Object.values(record)) {
    if (!isPlainObject(byType)) continue;
    for (const outputs of Object.values(byType)) {
      if (!Array.isArray(outputs)) continue;
      for (let i = 0; i < outputs.length; i += 1) {
        const slot = outputs[i];
        if (!Array.isArray(slot)) continue;
        outputs[i] = slot.filter(
          (target) => !(isPlainObject(target) && target.node === name),
        );
      }
    }
  }
}

/** Remove direct edges from one source to one target; empty slots stay. */
function stripDirectEdge(
  record: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const byType: unknown = record[from];
  if (!isPlainObject(byType)) return;
  for (const outputs of Object.values(byType)) {
    if (!Array.isArray(outputs)) continue;
    for (let i = 0; i < outputs.length; i += 1) {
      const slot = outputs[i];
      if (!Array.isArray(slot)) continue;
      outputs[i] = slot.filter(
        (target) => !(isPlainObject(target) && target.node === to),
      );
    }
  }
}

/**
 * Append a target to `record[from][type][sourceIndex]`, creating the source
 * key, type key, and any missing slots (filled with `[]`) as needed. An exact
 * duplicate (same `node` and `index` already in the slot) is skipped.
 */
function addEdge(
  record: Record<string, unknown>,
  from: string,
  type: string,
  sourceIndex: number,
  to: string,
  targetIndex: number,
): void {
  const existingByType: unknown = record[from];
  const byType: Record<string, unknown> = isPlainObject(existingByType)
    ? existingByType
    : {};
  record[from] = byType;
  const existingOutputs: unknown = byType[type];
  const outputs: unknown[] = Array.isArray(existingOutputs) ? existingOutputs : [];
  byType[type] = outputs;
  while (outputs.length <= sourceIndex) outputs.push([]);
  const existingSlot: unknown = outputs[sourceIndex];
  const slot: unknown[] = Array.isArray(existingSlot) ? existingSlot : [];
  outputs[sourceIndex] = slot;
  const duplicate = slot.some(
    (target: unknown) =>
      isPlainObject(target) && target.node === to && targetIndexOf(target) === targetIndex,
  );
  if (!duplicate) slot.push({ node: to, type, index: targetIndex });
}

function targetIndexOf(target: Record<string, unknown>): number {
  return typeof target.index === "number" ? target.index : 0;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
