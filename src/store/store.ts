/**
 * Pinned contract (issue #3): a SQLite-backed store, opened with
 * `openStore(path)`, guaranteeing (a) at most one `repair_events` row per
 * execution id — the first insert wins and later inserts report
 * `created:false` instead of failing, (b) reads of missing rows return `null`
 * rather than throwing, and (c) the five tables `repair_events`,
 * `workflow_snapshots`, `decisions`, `llm_traces`, `metrics` exist after the
 * first open on an empty file. All writes go through synchronous prepared
 * statements created once at open; the DB path comes from Settings
 * (`KINTSUGI_DB_PATH`, wired by the consumer) with `:memory:`/temp-file
 * overrides for tests. DDL is inline (`SCHEMA_DDL`) rather than a `schema.sql`
 * sibling: the build emits only JavaScript under dist/src (no copy step), so a
 * runtime-resolved `.sql` file would add a fragile `__dirname` lookup for no
 * gain. No foreign keys on purpose: the store stays order-independent across
 * its consumers (api + worker share the file); referential integrity is the
 * callers' job.
 */

import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

/** Applied with `db.exec()` on every open; every statement is idempotent. */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS repair_events (
  execution_id TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  payload      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_snapshots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_traces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  stage       TEXT NOT NULL,
  model       TEXT NOT NULL,
  llm_mode    TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  tokens_in   INTEGER NOT NULL,
  tokens_out  INTEGER NOT NULL,
  prompt      TEXT NOT NULL,
  response    TEXT NOT NULL,
  verdict     TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  name       TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status   ON repair_events(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_event ON workflow_snapshots(event_id);
CREATE INDEX IF NOT EXISTS idx_decisions_event ON decisions(event_id);
CREATE INDEX IF NOT EXISTS idx_traces_event    ON llm_traces(event_id);
`;

export interface StoredRepairEvent {
  executionId: string;
  status: string;
  receivedAt: string;
  payload: unknown;
}

export interface StoredWorkflowSnapshot {
  id: string;
  eventId: string;
  kind: string;
  workflowId: string;
  snapshot: unknown;
  createdAt: string;
}

export interface StoredDecision {
  id: number;
  eventId: string;
  stage: string;
  verdict: string;
  reason: string;
  confidence: number;
  createdAt: string;
}

export interface StoredLlmTrace {
  id: number;
  eventId: string;
  stage: string;
  model: string;
  llmMode: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  prompt: string;
  response: string;
  /** Parsed verdict JSON, or null when no verdict was recorded. */
  verdict: unknown;
  error: string | null;
  createdAt: string;
}

export interface InsertEventInput {
  executionId: string;
  payload: unknown;
}

export interface InsertSnapshotInput {
  id: string;
  eventId: string;
  kind: string;
  workflowId: string;
  snapshot: unknown;
}

export interface InsertDecisionInput {
  eventId: string;
  stage: string;
  verdict: string;
  reason: string;
  confidence: number;
}

export interface InsertTraceInput {
  eventId: string;
  stage: string;
  model: string;
  llmMode: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  prompt: string;
  response: string;
  verdict: unknown;
  error: string | null;
}

export interface Store {
  /** Idempotent by execution id (first write wins). */
  insertEvent(input: InsertEventInput): { executionId: string; created: boolean };
  getEvent(executionId: string): StoredRepairEvent | null;
  /** Insertion order (rowid ASC). */
  listEvents(): StoredRepairEvent[];

  /** Idempotent by snapshot id (first write wins). */
  insertSnapshot(input: InsertSnapshotInput): { id: string; created: boolean };
  getSnapshot(id: string): StoredWorkflowSnapshot | null;

  /** Autoincrement id; `listDecisions` reads them back in insertion order. */
  insertDecision(input: InsertDecisionInput): StoredDecision;
  listDecisions(eventId: string): StoredDecision[];

  insertTrace(input: InsertTraceInput): StoredLlmTrace;
  listTraces(eventId: string): StoredLlmTrace[];

  /** Atomic read-modify-write upsert; returns the counter's new value. */
  incrementMetric(name: string, by?: number): number;
  getMetrics(): Record<string, number>;

  close(): void;
}

/**
 * node:sqlite binds only string/number/null — a bare `JSON.stringify` can
 * yield `undefined` (for undefined/function input) or throw (BigInt), so the
 * failure is surfaced here as a typed, explained error instead of a bind-time
 * SQLite exception.
 */
function encodeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value serializes to undefined");
    return encoded;
  } catch (cause) {
    throw new TypeError("store: value is not JSON-serializable", { cause });
  }
}

function decodeJson(value: unknown): unknown {
  return JSON.parse(value as string) as unknown;
}

/** PRD §7.6 pins LLM trace prompt/response bodies at 32,768 characters. */
const TRACE_TEXT_CAP = 32_768;

function capText(value: string): string {
  return value.length <= TRACE_TEXT_CAP ? value : value.slice(0, TRACE_TEXT_CAP);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `StatementResultingChanges.changes` is typed `number | bigint` (bigints only
 * when the connection opts into them); this connection does not, but the
 * coercion keeps both runtime and typechecker honest.
 */
function changesOf(result: { changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

/**
 * Row objects from node:sqlite are `null`-prototype records; this picks a
 * column as a concrete type without tripping `noUncheckedIndexedAccess`.
 */
function column(row: Record<string, SQLOutputValue>, name: string): SQLOutputValue {
  const value = row[name];
  if (value === undefined) throw new Error(`store: column ${name} missing in row`);
  return value;
}

function stringColumn(row: Record<string, SQLOutputValue>, name: string): string {
  const value = column(row, name);
  if (typeof value !== "string") throw new Error(`store: column ${name} is not TEXT`);
  return value;
}

function numberColumn(row: Record<string, SQLOutputValue>, name: string): number {
  const value = column(row, name);
  if (typeof value !== "number") throw new Error(`store: column ${name} is not numeric`);
  return value;
}

function mapEventRow(row: Record<string, SQLOutputValue>): StoredRepairEvent {
  return {
    executionId: stringColumn(row, "execution_id"),
    status: stringColumn(row, "status"),
    receivedAt: stringColumn(row, "received_at"),
    payload: decodeJson(column(row, "payload")),
  };
}

function mapSnapshotRow(row: Record<string, SQLOutputValue>): StoredWorkflowSnapshot {
  return {
    id: stringColumn(row, "id"),
    eventId: stringColumn(row, "event_id"),
    kind: stringColumn(row, "kind"),
    workflowId: stringColumn(row, "workflow_id"),
    snapshot: decodeJson(column(row, "snapshot")),
    createdAt: stringColumn(row, "created_at"),
  };
}

function mapDecisionRow(row: Record<string, SQLOutputValue>): StoredDecision {
  return {
    id: numberColumn(row, "id"),
    eventId: stringColumn(row, "event_id"),
    stage: stringColumn(row, "stage"),
    verdict: stringColumn(row, "verdict"),
    reason: stringColumn(row, "reason"),
    confidence: numberColumn(row, "confidence"),
    createdAt: stringColumn(row, "created_at"),
  };
}

function mapTraceRow(row: Record<string, SQLOutputValue>): StoredLlmTrace {
  return {
    id: numberColumn(row, "id"),
    eventId: stringColumn(row, "event_id"),
    stage: stringColumn(row, "stage"),
    model: stringColumn(row, "model"),
    llmMode: stringColumn(row, "llm_mode"),
    durationMs: numberColumn(row, "duration_ms"),
    tokensIn: numberColumn(row, "tokens_in"),
    tokensOut: numberColumn(row, "tokens_out"),
    prompt: stringColumn(row, "prompt"),
    response: stringColumn(row, "response"),
    verdict: column(row, "verdict") === null ? null : decodeJson(column(row, "verdict")),
    error: (column(row, "error") as string | null) ?? null,
    createdAt: stringColumn(row, "created_at"),
  };
}

/**
 * Opens (creating if absent) the SQLite database at `path` — a filesystem path
 * or `:memory:` — applies the schema and prepares every statement once, so a
 * bad query fails at open rather than mid-request. Single writer by design:
 * callers pass the path from Settings; WAL + busy_timeout absorb the
 * api/worker concurrent access to the same file.
 */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  // WAL: readers do not block the writer. No-op on :memory:.
  db.exec("PRAGMA journal_mode = WAL");
  // Worker + receiver share the file; wait instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_DDL);

  const stmt = {
    insertEvent: db.prepare(
      "INSERT INTO repair_events (execution_id, status, received_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    getEvent: db.prepare(
      "SELECT execution_id, status, received_at, payload FROM repair_events WHERE execution_id = ?",
    ),
    listEvents: db.prepare(
      "SELECT execution_id, status, received_at, payload FROM repair_events ORDER BY rowid ASC",
    ),

    insertSnapshot: db.prepare(
      "INSERT INTO workflow_snapshots (id, event_id, kind, workflow_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    getSnapshot: db.prepare(
      "SELECT id, event_id, kind, workflow_id, snapshot, created_at FROM workflow_snapshots WHERE id = ?",
    ),

    insertDecision: db.prepare(
      "INSERT INTO decisions (event_id, stage, verdict, reason, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    listDecisions: db.prepare(
      "SELECT id, event_id, stage, verdict, reason, confidence, created_at FROM decisions WHERE event_id = ? ORDER BY id ASC",
    ),

    insertTrace: db.prepare(
      "INSERT INTO llm_traces (event_id, stage, model, llm_mode, duration_ms, tokens_in, tokens_out, prompt, response, verdict, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    listTraces: db.prepare(
      "SELECT id, event_id, stage, model, llm_mode, duration_ms, tokens_in, tokens_out, prompt, response, verdict, error, created_at FROM llm_traces WHERE event_id = ? ORDER BY id ASC",
    ),

    incrementMetric: db.prepare(
      "INSERT INTO metrics (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at RETURNING value",
    ),
    getMetrics: db.prepare("SELECT name, value FROM metrics"),
  };

  const eventStatusInitial = "received";

  return Object.freeze({
    insertEvent(input: InsertEventInput): { executionId: string; created: boolean } {
      const created = changesOf(
        stmt.insertEvent.run(
          input.executionId,
          eventStatusInitial,
          nowIso(),
          encodeJson(input.payload),
        ),
      );
      return { executionId: input.executionId, created };
    },
    getEvent(executionId: string): StoredRepairEvent | null {
      const row = stmt.getEvent.get(executionId);
      return row === undefined ? null : mapEventRow(row);
    },
    listEvents(): StoredRepairEvent[] {
      return stmt.listEvents.all().map(mapEventRow);
    },

    insertSnapshot(input: InsertSnapshotInput): { id: string; created: boolean } {
      const created = changesOf(
        stmt.insertSnapshot.run(
          input.id,
          input.eventId,
          input.kind,
          input.workflowId,
          encodeJson(input.snapshot),
          nowIso(),
        ),
      );
      return { id: input.id, created };
    },
    getSnapshot(id: string): StoredWorkflowSnapshot | null {
      const row = stmt.getSnapshot.get(id);
      return row === undefined ? null : mapSnapshotRow(row);
    },

    insertDecision(input: InsertDecisionInput): StoredDecision {
      const createdAt = nowIso();
      const result = stmt.insertDecision.run(
        input.eventId,
        input.stage,
        input.verdict,
        input.reason,
        input.confidence,
        createdAt,
      );
      return {
        id: Number(result.lastInsertRowid),
        eventId: input.eventId,
        stage: input.stage,
        verdict: input.verdict,
        reason: input.reason,
        confidence: input.confidence,
        createdAt,
      };
    },
    listDecisions(eventId: string): StoredDecision[] {
      return stmt.listDecisions.all(eventId).map(mapDecisionRow);
    },

    insertTrace(input: InsertTraceInput): StoredLlmTrace {
      const createdAt = nowIso();
      const verdict = input.verdict === null ? null : encodeJson(input.verdict);
      const result = stmt.insertTrace.run(
        input.eventId,
        input.stage,
        input.model,
        input.llmMode,
        input.durationMs,
        input.tokensIn,
        input.tokensOut,
        capText(input.prompt),
        capText(input.response),
        verdict,
        input.error,
        createdAt,
      );
      return {
        id: Number(result.lastInsertRowid),
        eventId: input.eventId,
        stage: input.stage,
        model: input.model,
        llmMode: input.llmMode,
        durationMs: input.durationMs,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        // Capping is the store's job so it holds no matter which caller forgets.
        prompt: capText(input.prompt),
        response: capText(input.response),
        verdict: input.verdict,
        error: input.error,
        createdAt,
      };
    },
    listTraces(eventId: string): StoredLlmTrace[] {
      return stmt.listTraces.all(eventId).map(mapTraceRow);
    },

    incrementMetric(name: string, by = 1): number {
      if (typeof by !== "number" || !Number.isFinite(by)) {
        throw new TypeError("store: metric increment must be a finite number");
      }
      const row = stmt.incrementMetric.get(name, by, nowIso());
      if (row === undefined) throw new Error("store: metric upsert returned no row");
      return numberColumn(row, "value");
    },
    getMetrics(): Record<string, number> {
      const counters: Record<string, number> = {};
      for (const row of stmt.getMetrics.all()) {
        counters[stringColumn(row, "name")] = numberColumn(row, "value");
      }
      return counters;
    },

    close(): void {
      db.close();
    },
  });
}
