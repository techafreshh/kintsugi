/**
 * Pinned contract (issue #15): deterministic verdict on a sandboxed replay.
 * `deriveExpectations` distills the workflow's last-known-good execution into
 * row-count, per-field value types, and observed null rates; `verify` checks
 * replayed rows against those expectations (record counts, value types,
 * null rates) and returns a strict `{ ok, failures }` verdict. Pure over
 * untrusted data: never throws, never mutates its inputs, no dependencies —
 * configuration arrives only through arguments, never `process.env`.
 */

/** Ceiling applied when expectations omit `maxNullRate`. */
export const DEFAULT_MAX_NULL_RATE = 0.2;

/** Expectations distilled from the last successful stored execution. */
export interface SandboxExpectations {
  /** Rows the replay should return; omitted means "do not check". */
  recordCount?: number;
  /** Expected `typeof` per field, from the first non-null value seen. */
  fieldTypes?: Record<string, string>;
  /** Default null-rate ceiling per field; defaults to 0.2 when omitted. */
  maxNullRate?: number;
  /** Per-field null-rate ceiling override. */
  fieldNullRates?: Record<string, number>;
  [key: string]: unknown;
}

/** One failed check in a verification verdict. */
export interface VerifyFailure {
  /** Which check failed: count, null-rate, or value-type comparison. */
  check: "record-count" | "null-rate" | "type";
  /** Field the failure belongs to (absent for whole-output checks). */
  field?: string;
  /** Expected value (count, ceiling, or type name). */
  expected: unknown;
  /** Actual value (count, observed rate, or type name). */
  actual: unknown;
  /** Human-readable one-line description. */
  message: string;
}

/** Strict verdict shape: `ok` is true exactly when `failures` is empty. */
export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
}

/**
 * Collect replay rows from any accepted actual shape: a bare array, a
 * `{ rows | data | output | result | items }` array container, or n8n
 * execution JSON (`data.resultData.runData`, `resultData.runData`, top-level
 * `runData`, or the run-data map itself `{ node: [{ json }] }`). n8n task
 * wrappers are unwrapped to their `json` payloads. Unrecognized input yields
 * no rows; a lone record is treated as one row. Never throws.
 */
export function extractRows(actual: unknown): Array<Record<string, unknown>> {
  try {
    return collectRows(actual);
  } catch {
    return [];
  }
}

/**
 * Distill expectations from the last successful execution. Accepts the same
 * shapes as `extractRows`: row count, per-field `typeof` from the first
 * non-null value, observed per-field null rates, and the default
 * `maxNullRate` ceiling of 0.2. Never throws; malformed input yields
 * zero-count expectations with the default ceiling.
 */
export function deriveExpectations(lastSuccess: unknown): SandboxExpectations {
  try {
    const rows = collectRows(lastSuccess);
    const fields = unionFields(rows);
    const fieldTypes: Record<string, string> = {};
    const fieldNullRates: Record<string, number> = {};
    for (const field of fields) {
      let nulls = 0;
      let seen: string | undefined;
      for (const row of rows) {
        const value = row[field];
        if (value === null || value === undefined) {
          nulls += 1;
          continue;
        }
        if (seen === undefined) seen = typeof value;
      }
      if (seen !== undefined) fieldTypes[field] = seen;
      fieldNullRates[field] = rows.length === 0 ? 0 : nulls / rows.length;
    }
    return {
      recordCount: rows.length,
      fieldTypes,
      maxNullRate: DEFAULT_MAX_NULL_RATE,
      fieldNullRates,
    };
  } catch {
    return {
      recordCount: 0,
      fieldTypes: {},
      maxNullRate: DEFAULT_MAX_NULL_RATE,
      fieldNullRates: {},
    };
  }
}

/**
 * Check replayed output against expectations. Never throws: malformed actual
 * reads as zero rows, malformed expectations read as no checks, and any
 * internal failure degrades to a single `record-count` failure instead of an
 * exception. Record-count failures carry the raw numbers
 * (`{ check: "record-count", expected, actual }`); null-rate failures carry
 * `{ check: "null-rate", field, expected: ceiling, actual: rate }`; type
 * failures carry `{ check: "type", field, expected, actual }` with type names.
 */
export function verify(actual: unknown, expectations: unknown): VerifyResult {
  try {
    const rows = collectRows(actual);
    const expected = normalizeExpectations(expectations);
    const failures: VerifyFailure[] = [];

    if (expected.recordCount !== undefined) {
      if (rows.length !== expected.recordCount) {
        failures.push({
          check: "record-count",
          expected: expected.recordCount,
          actual: rows.length,
          message: `record count mismatch: expected ${expected.recordCount}, got ${rows.length}`,
        });
      }
    }

    for (const [field, expectedType] of Object.entries(expected.fieldTypes)) {
      const observed = firstMismatchedType(rows, field, expectedType);
      if (observed !== null) {
        failures.push({
          check: "type",
          field,
          expected: expectedType,
          actual: observed,
          message: `type mismatch on field ${JSON.stringify(field)}: expected ${expectedType}, got ${observed}`,
        });
      }
    }

    if (rows.length > 0) {
      for (const field of unionFields([...Object.keys(expected.fieldTypes), ...Object.keys(expected.fieldNullRates), ...unionFields(rows)])) {
        const ceiling = ceilingFor(field, expected);
        const rate = nullRate(rows, field);
        if (rate > ceiling) {
          failures.push({
            check: "null-rate",
            field,
            expected: ceiling,
            actual: rate,
            message: `null rate on field ${JSON.stringify(field)} is ${rate}, above the ceiling of ${ceiling}`,
          });
        }
      }
    }

    return { ok: failures.length === 0, failures };
  } catch (cause) {
    return {
      ok: false,
      failures: [
        {
          check: "record-count",
          expected: 0,
          actual: 0,
          message: `verify failed: ${describeValue(cause)}`,
        },
      ],
    };
  }
}

function collectRows(actual: unknown): Array<Record<string, unknown>> {
  if (actual === null || actual === undefined) return [];
  if (Array.isArray(actual)) return actual.map(toRow);
  if (!isPlainObject(actual)) return [];
  if (Array.isArray(actual.rows)) return actual.rows.map(toRow);
  if (Array.isArray(actual.data)) return actual.data.map(toRow);
  if (Array.isArray(actual.output)) return actual.output.map(toRow);
  if (Array.isArray(actual.result)) return actual.result.map(toRow);
  if (Array.isArray(actual.results)) return actual.results.map(toRow);
  if (Array.isArray(actual.items)) return actual.items.map(toRow);
  if (actual.runData !== undefined) {
    const fromRunData = runDataRows(actual.runData);
    if (fromRunData !== null) return fromRunData;
  }
  if (isPlainObject(actual.resultData) && actual.resultData.runData !== undefined) {
    const fromResult = runDataRows(actual.resultData.runData);
    if (fromResult !== null) return fromResult;
  }
  if (isPlainObject(actual.data)) {
    const nested = collectRows(actual.data);
    if (nested.length > 0 || hasExecutionKeys(actual.data)) return nested;
  }
  if (isPlainObject(actual.resultData)) {
    const nested = collectRows(actual.resultData);
    if (nested.length > 0) return nested;
  }
  if (isPlainObject(actual.execution)) {
    const nested = collectRows(actual.execution);
    if (nested.length > 0 || hasExecutionKeys(actual.execution)) return nested;
  }
  if (isPlainObject(actual.output)) {
    const nested = collectRows(actual.output);
    if (nested.length > 0) return nested;
  }
  if (isPlainObject(actual.result) && !Array.isArray(actual.result)) {
    const nested = collectRows(actual.result);
    if (nested.length > 0) return nested;
  }
  if (isRunDataMap(actual)) return runDataRows(actual) ?? [];
  if (isSandboxMeta(actual)) return [];
  return [actual];
}

/** Whether the object carries execution-container keys worth recursing into. */
function hasExecutionKeys(value: Record<string, unknown>): boolean {
  return (
    value.runData !== undefined ||
    value.resultData !== undefined ||
    value.execution !== undefined ||
    value.rows !== undefined ||
    value.data !== undefined ||
    value.output !== undefined ||
    value.result !== undefined
  );
}

/** Result wrappers are not rows: a bare `{ strategy, ... }` reads as no rows. */
function isSandboxMeta(value: Record<string, unknown>): boolean {
  return (
    typeof value.strategy === "string" ||
    value.sandboxWorkflowId !== undefined ||
    value.sandboxId !== undefined ||
    typeof value.recordCount === "number" ||
    isPlainObject(value.fieldTypes)
  );
}

/** True when every value is an array or a `{ json }` task wrapper. */
function isRunDataMap(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, tasks]) => Array.isArray(tasks) || isTaskWrapper(tasks));
}

function isTaskWrapper(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.hasOwn(value, "json");
}

/** Unwrap one n8n run-data map `{ node: [task, ...] }` into row records. */
function runDataRows(runData: unknown): Array<Record<string, unknown>> | null {
  if (!isPlainObject(runData)) return null;
  const rows: Array<Record<string, unknown>> = [];
  let usable = false;
  for (const tasks of Object.values(runData)) {
    const list = Array.isArray(tasks) ? tasks : isPlainObject(tasks) ? [tasks] : null;
    if (list === null) continue;
    usable = true;
    for (const task of list) rows.push(toRow(unwrapTask(task)));
  }
  return usable ? rows : null;
}

function unwrapTask(task: unknown): unknown {
  if (isPlainObject(task) && Object.hasOwn(task, "json")) return task.json;
  return task;
}

/** Normalize one row: plain objects pass through, task wrappers unwrap,
 * primitives wrap as `{ value }` so counts and null rates still apply. */
function toRow(value: unknown): Record<string, unknown> {
  const unwrapped = unwrapTask(value);
  if (isPlainObject(unwrapped)) return unwrapped;
  return { value: unwrapped };
}

interface NormalizedExpectations {
  recordCount: number | undefined;
  fieldTypes: Record<string, string>;
  maxNullRate: number | undefined;
  fieldNullRates: Record<string, number>;
}

function normalizeExpectations(expectations: unknown): NormalizedExpectations {
  const empty: NormalizedExpectations = {
    recordCount: undefined,
    fieldTypes: {},
    maxNullRate: undefined,
    fieldNullRates: {},
  };
  if (typeof expectations === "number") {
    if (Number.isFinite(expectations)) empty.recordCount = expectations;
    return empty;
  }
  if (!isPlainObject(expectations)) return empty;
  const recordCount = firstFiniteNumber(
    expectations.recordCount,
    expectations.expectedRecordCount,
    expectations.rowCount,
    expectations.expectedRows,
    expectations.expectedCount,
    expectations.count,
  );
  if (recordCount !== undefined) empty.recordCount = recordCount;
  const fieldTypes = firstPlainRecord(
    expectations.fieldTypes,
    expectations.types,
    expectations.expectedTypes,
    expectations.columnTypes,
  );
  if (fieldTypes !== undefined) {
    for (const [field, type] of Object.entries(fieldTypes)) {
      if (typeof type === "string" && type !== "") empty.fieldTypes[field] = type;
    }
  }
  const maxNullRate = firstFiniteNumber(
    expectations.maxNullRate,
    expectations.maxNull,
    expectations.nullRateCeiling,
    expectations.maxNullRateAllowed,
    expectations.nullRate,
  );
  if (maxNullRate !== undefined) empty.maxNullRate = maxNullRate;
  const fieldNullRates = firstPlainRecord(
    expectations.fieldNullRates,
    expectations.nullRates,
    expectations.perFieldNullRates,
    expectations.columnNullRates,
  );
  if (fieldNullRates !== undefined) {
    for (const [field, rate] of Object.entries(fieldNullRates)) {
      if (typeof rate === "number" && Number.isFinite(rate)) empty.fieldNullRates[field] = rate;
    }
  }
  return empty;
}

function firstFiniteNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function firstPlainRecord(...candidates: unknown[]): Record<string, unknown> | undefined {
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) return candidate;
  }
  return undefined;
}

/** `typeof` of the first non-null value disagreeing with the expectation. */
function firstMismatchedType(
  rows: Array<Record<string, unknown>>,
  field: string,
  expectedType: string,
): string | null {
  for (const row of rows) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (value === null || value === undefined) continue;
    const actualType = typeof value;
    if (actualType !== expectedType) return actualType;
  }
  return null;
}

function ceilingFor(
  field: string,
  expected: NormalizedExpectations,
): number {
  const override = expected.fieldNullRates[field];
  if (typeof override === "number") return override;
  if (typeof expected.maxNullRate === "number") return expected.maxNullRate;
  return DEFAULT_MAX_NULL_RATE;
}

function nullRate(rows: Array<Record<string, unknown>>, field: string): number {
  if (rows.length === 0) return 0;
  let nulls = 0;
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) nulls += 1;
  }
  return nulls / rows.length;
}

function unionFields(rows: Array<Record<string, unknown>> | string[]): string[] {
  const seen = new Set<string>();
  if (rows.length > 0 && typeof rows[0] === "string") {
    for (const field of rows as string[]) seen.add(field);
    return [...seen];
  }
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
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
