import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/store/store.js";

const ISSUE_3_TABLES = ["repair_events", "workflow_snapshots", "decisions", "llm_traces", "metrics"];

let store: Store;

beforeEach(() => {
  // :memory: is the issue's test-override path — every test below runs on it.
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("repair events", () => {
  it("inserts once per execution id: created:true then created:false, row count 1", () => {
    const first = store.insertEvent({ executionId: "e1", payload: { error: { message: "first" } } });
    const second = store.insertEvent({ executionId: "e1", payload: { error: { message: "second" } } });
    expect(first).toEqual({ executionId: "e1", created: true });
    expect(second).toEqual({ executionId: "e1", created: false });
    expect(store.listEvents()).toHaveLength(1);
    // First write wins over the duplicate.
    expect(store.listEvents()[0]?.payload).toEqual({ error: { message: "first" } });
  });

  it("returns exactly null for a never-inserted id, without throwing", () => {
    expect(store.getEvent("missing")).toBeNull();
  });

  it("stores the pinned record shape: status received, ISO received_at, payload JSON round-trip", () => {
    store.insertEvent({ executionId: "e2", payload: { workflow: { id: "wf-9" }, unicode: "ünïcødé ✓" } });
    const event = store.getEvent("e2");
    expect(event).toEqual({
      executionId: "e2",
      status: "received",
      receivedAt: expect.any(String),
      payload: { workflow: { id: "wf-9" }, unicode: "ünïcødé ✓" },
    });
    expect(() => new Date(event?.receivedAt ?? "").toISOString()).not.toThrow();
  });

  it("lists events in insertion order", () => {
    store.insertEvent({ executionId: "a", payload: {} });
    store.insertEvent({ executionId: "b", payload: {} });
    expect(store.listEvents().map((event) => event.executionId)).toEqual(["a", "b"]);
  });
});

describe("workflow snapshots", () => {
  it("round-trips $ref-free JSON so the read-back deep-equals what was stored", () => {
    const snapshot = {
      name: "order-flow",
      nodes: [{ name: "ship", parameters: { retries: 3, note: null, price: 12.5 } }],
      unicode: "Flüssig — ✓",
      nested: { list: [1, "two", null, { deep: true }] },
    };
    const inserted = store.insertSnapshot({
      id: "snap-1",
      eventId: "e1",
      kind: "pre-repair",
      workflowId: "wf-1",
      snapshot,
    });
    expect(inserted).toEqual({ id: "snap-1", created: true });
    expect(store.getSnapshot("snap-1")).toEqual({
      id: "snap-1",
      eventId: "e1",
      kind: "pre-repair",
      workflowId: "wf-1",
      snapshot,
      createdAt: expect.any(String),
    });
  });

  it("keeps the original snapshot on duplicate id (created:false)", () => {
    store.insertSnapshot({ id: "snap-1", eventId: "e1", kind: "pre-repair", workflowId: "wf-1", snapshot: { v: 1 } });
    const second = store.insertSnapshot({ id: "snap-1", eventId: "e1", kind: "pre-repair", workflowId: "wf-1", snapshot: { v: 2 } });
    expect(second).toEqual({ id: "snap-1", created: false });
    expect(store.getSnapshot("snap-1")?.snapshot).toEqual({ v: 1 });
  });

  it("returns null for a missing snapshot id", () => {
    expect(store.getSnapshot("no-such-snapshot")).toBeNull();
  });
});

describe("decisions", () => {
  it("lists only the requested event's decisions in insertion order with confidence preserved", () => {
    const first = store.insertDecision({
      eventId: "e1",
      stage: "diagnose",
      verdict: "patch",
      reason: "typo in expr",
      confidence: 0.92,
    });
    store.insertDecision({ eventId: "e2", stage: "diagnose", verdict: "requeue", reason: "timeout", confidence: 0.4 });
    const second = store.insertDecision({
      eventId: "e1",
      stage: "judge",
      verdict: "approve",
      reason: "diff matches diagnosis",
      confidence: 0.85,
    });
    expect(store.listDecisions("e1")).toEqual([first, second]);
    expect(store.listDecisions("e2")).toHaveLength(1);
    expect(first.confidence).toBe(0.92);
    expect(store.listDecisions("e1").map((decision) => decision.id)).toEqual([first.id, second.id]);
  });
});

describe("llm traces", () => {
  it("caps prompt and response at 32,768 chars and keeps meta fields intact", () => {
    const verdict = { verdict: "patch", rationale: "expression typo" };
    const trace = store.insertTrace({
      eventId: "e1",
      stage: "diagnose",
      model: "meta-llama-3.1-70b",
      llmMode: "api",
      durationMs: 812,
      tokensIn: 1955,
      tokensOut: 210,
      prompt: "p".repeat(40_000),
      response: "ok",
      verdict,
      error: null,
    });
    expect(trace.prompt).toHaveLength(32_768);
    expect(trace.response).toBe("ok");
    expect(trace.verdict).toEqual(verdict);
    expect(trace.error).toBeNull();
    const stored = store.listTraces("e1")[0];
    expect(stored?.prompt).toHaveLength(32_768);
    expect(stored?.verdict).toEqual(verdict);
    expect(stored?.error).toBeNull();
  });

  it("parses a stored verdict back to the original object and filters by event id", () => {
    const verdict = { verdict: "reject", rationale: "unsafe diff" };
    store.insertTrace({ eventId: "e1", stage: "judge", model: "m", llmMode: "api", durationMs: 1, tokensIn: 1, tokensOut: 1, prompt: "p", response: "r", verdict, error: null });
    store.insertTrace({ eventId: "e2", stage: "judge", model: "m", llmMode: "api", durationMs: 1, tokensIn: 1, tokensOut: 1, prompt: "p", response: "r", verdict: null, error: "boom" });
    const forE1 = store.listTraces("e1");
    expect(forE1).toHaveLength(1);
    expect(forE1[0]?.verdict).toEqual(verdict);
    const forE2 = store.listTraces("e2");
    expect(forE2).toHaveLength(1);
    expect(forE2[0]?.verdict).toBeNull();
    expect(forE2[0]?.error).toBe("boom");
    expect(store.listTraces("e3")).toHaveLength(0);
  });
});

describe("metrics", () => {
  it("accumulates increments and reports every counter", () => {
    store.incrementMetric("repairs_started");
    store.incrementMetric("repairs_started");
    const third = store.incrementMetric("repairs_started");
    expect(third).toBe(3);
    expect(store.getMetrics()).toEqual({ repairs_started: 3 });
  });

  it("applies a custom increment and returns the new value", () => {
    expect(store.incrementMetric("llm_latency", 12)).toBe(12);
    expect(store.incrementMetric("llm_latency")).toBe(13);
  });

  it("starts empty on a fresh store", () => {
    expect(store.getMetrics()).toEqual({});
  });
});

describe("schema on first open", () => {
  it("creates all five pinned tables on an empty file, verified through an independent connection", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kintsugi-store-"));
    try {
      const dbPath = join(tempDir, "kintsugi.db");
      const fileStore = openStore(dbPath);
      fileStore.close();
      const raw = new DatabaseSync(dbPath);
      try {
        const tables = raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((row) => (row as { name: string }).name);
        for (const table of ISSUE_3_TABLES) {
          expect(tables, `table ${table} exists`).toContain(table);
        }
      } finally {
        raw.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reopening reuses the existing schema (idempotent DDL)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kintsugi-store-"));
    try {
      const dbPath = join(tempDir, "kintsugi.db");
      const first = openStore(dbPath);
      first.insertEvent({ executionId: "persisted", payload: { n: 1 } });
      first.close();
      const second = openStore(dbPath);
      try {
        expect(second.getEvent("persisted")?.payload).toEqual({ n: 1 });
      } finally {
        second.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
