import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/receiver/app.js";
import { loadSettings } from "../src/config/settings.js";
import { openStore, type Store } from "../src/store/store.js";

const openStores: Store[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

/** Fresh store-backed app per test so suites never share rows. */
function makeApp(env: Record<string, string> = {}): { app: Hono; store: Store } {
  const settings = loadSettings({ ...process.env, ...env });
  const store = openStore(":memory:");
  openStores.push(store);
  return { app: createApp({ store, settings }), store };
}

const workflowBefore = {
  nodes: [{ name: "Code", type: "n8n-nodes-base.code", parameters: { value: "old" } }],
};
const workflowAfter = {
  nodes: [{ name: "Code", type: "n8n-nodes-base.code", parameters: { value: "new" } }],
};

function seedDiffEvent(store: Store, eventId = "evt-diff"): void {
  store.insertEvent({ executionId: eventId, payload: { execution: { id: eventId } } });
  store.insertSnapshot({
    id: `${eventId}-pre`,
    eventId,
    kind: "pre-repair",
    workflowId: "wf-1",
    snapshot: workflowBefore,
  });
  store.insertSnapshot({
    id: `${eventId}-post`,
    eventId,
    kind: "pre-promotion",
    workflowId: "wf-1",
    snapshot: workflowAfter,
  });
}

describe("GET / dashboard page", () => {
  it("contains Metrics, Events, and a feed pill container", async () => {
    const { app, store } = makeApp();
    store.insertEvent({ executionId: "fresh-1", payload: { ok: true } });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Metrics");
    expect(html).toContain("Events");
    expect(html).toContain('<div id="feed');
  });

  it("renders an explicit empty block when no events exist", async () => {
    const { app } = makeApp();
    const html = await (await app.request("/")).text();
    expect(html).toContain('<div id="feed');
    const feed = await (await app.request("/dashboard/feed")).text();
    expect(feed).toContain("no events");
  });
});

describe("GET /dashboard/events/:id detail", () => {
  it("renders a side-by-side diff with parameters.value on both sides", async () => {
    const { app, store } = makeApp();
    seedDiffEvent(store);
    const res = await app.request("/dashboard/events/evt-diff");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("diff");
    // Dotted leaf path from diffWorkflows must be visible more than once
    // (once per before/after side cell).
    const hits = html.split("parameters.value").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it("renders an llm_traces timeline with the literal diagnose stage", async () => {
    const { app, store } = makeApp();
    store.insertEvent({ executionId: "evt-trace", payload: {} });
    store.insertTrace({
      eventId: "evt-trace",
      stage: "diagnose",
      model: "mock-fast",
      llmMode: "mock",
      durationMs: 7,
      tokensIn: 10,
      tokensOut: 5,
      prompt: "p",
      response: "r",
      verdict: { rootCauseKind: "schema-drift" },
      error: null,
    });
    const html = await (await app.request("/dashboard/events/evt-trace")).text();
    expect(html).toContain("trace-timeline");
    expect(html).toContain('"diagnose"');
  });

  it("answers 404 HTML for an unknown event", async () => {
    const { app } = makeApp();
    const res = await app.request("/dashboard/events/missing");
    expect(res.status).toBe(404);
  });
});

describe("dashboard token round-trip", () => {
  it("embeds data-token and gates Approve via the Bearer header", async () => {
    const { app, store } = makeApp({ DASHBOARD_TOKEN: "s3cret" });
    store.insertEvent({ executionId: "evt-gate", payload: {} });
    const index = await (await app.request("/")).text();
    expect(index).toContain('data-token="s3cret"');
    const detail = await (await app.request("/dashboard/events/evt-gate")).text();
    expect(detail).toContain("Approve");
    expect(detail).toContain("hx-post");
    const denied = await app.request("/repair-events/evt-gate/approve", { method: "POST" });
    expect(denied.status).toBe(401);
    const allowed = await app.request("/repair-events/evt-gate/approve", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
  });
});
