import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { loadSettings, type Settings } from "../config/settings.js";
import { createOrchestrator, type Orchestrator } from "../orchestrator/orchestrator.js";
import { renderDetail, renderFeed, renderIndex } from "./dashboard.js";
import type { LLMPort } from "../llm/port.js";
import { handleTelegramUpdate } from "../notify/telegram.js";
import { openStore, type Store, type StoredRepairEvent } from "../store/store.js";

/** Static roots tried in order: built output first, repo source fallback. */
const STATIC_ROOTS = ["dist/public", "public"] as const;

export interface CreateAppOptions {
  store: Store;
  settings: Settings;
  /** Shared orchestrator for Telegram callbacks; built from store/settings when unset. */
  orchestrator?: Orchestrator | null | undefined;
  /** Injectable Telegram transport for the webhook answer path; defaults to global fetch. */
  fetchFn?: typeof fetch | null | undefined;
}

/** Wire spelling of a stored status (issue #26): the store keeps the
 * hyphenated `awaiting-approval`, while HTTP responses show the
 * underscored `awaiting_approval` the issue contract pins. */
function wireStatus(status: string): string {
  return status === "awaiting-approval" ? "awaiting_approval" : status;
}

/** Pinned event JSON shape shared by the list/detail/action responses. */
function eventJson(row: StoredRepairEvent): {
  event_id: string;
  status: string;
  received_at: string;
  payload: unknown;
} {
  return {
    event_id: row.executionId,
    status: wireStatus(row.status),
    received_at: row.receivedAt,
    payload: row.payload,
  };
}

/**
 * Per-event tier for the detail response (issue #24): the latest
 * `stage: "tier"` decision verdict, with the classifier's `auto-promote`
 * aliased to the `auto` wording the issue contract uses. `null` when the
 * event has not been through tier classification yet (e.g. freshly
 * received, or promoted via the dashboard without a repair turn).
 */
function tierOf(store: Store, eventId: string): string | null {
  let decisions: Array<{ stage: string; verdict: string }>;
  try {
    decisions = store.listDecisions(eventId);
  } catch {
    return null;
  }
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision === undefined || decision.stage !== "tier") continue;
    return decision.verdict === "auto-promote" ? "auto" : decision.verdict;
  }
  return null;
}

/** Sandbox verification summary for the detail response (issue #24). */
interface VerificationView {
  /** True exactly when a `verified` verdict decision exists for the event. */
  ok: boolean;
  /** Transport that produced the replay (`run-endpoint`, ...), if recorded. */
  strategy: string | null;
  /** Replayed row count, if recorded. */
  rowCount: number | null;
  /** Where the replayed payload came from, if recorded. */
  provenance: string | null;
  /** Latest verify-decision reason text, if any. */
  reason: string | null;
}

/**
 * Build the verification block from the event's decision rows: `ok` comes
 * from the `verify`-stage verdicts the orchestrator always writes, while
 * `strategy`/`rowCount`/`provenance` come from the structured JSON reason
 * of the richest `sandbox`/`verify` row (the E2E verify hook records one;
 * the default green path has none, leaving those fields null but `ok`
 * true). Never throws: store failures degrade to a red block, never a 500.
 */
function verificationOf(store: Store, eventId: string): VerificationView {
  const red: VerificationView = {
    ok: false,
    strategy: null,
    rowCount: null,
    provenance: null,
    reason: null,
  };
  let decisions: Array<{ stage: string; verdict: string; reason: string }>;
  try {
    decisions = store.listDecisions(eventId);
  } catch {
    return red;
  }
  let ok = false;
  let reason: string | null = null;
  let strategy: string | null = null;
  let rowCount: number | null = null;
  let provenance: string | null = null;
  for (const decision of decisions) {
    if (decision.stage === "verify") {
      if (decision.verdict === "verified") ok = true;
      reason = decision.reason;
    }
    if (decision.stage === "sandbox" || decision.stage === "verify") {
      const parsed = parseJsonObject(decision.reason);
      if (parsed !== null) {
        if (strategy === null && typeof parsed.strategy === "string") {
          strategy = parsed.strategy;
        }
        if (rowCount === null && typeof parsed.rowCount === "number") {
          rowCount = parsed.rowCount;
        }
        if (provenance === null && typeof parsed.provenance === "string") {
          provenance = parsed.provenance;
        }
      }
    }
  }
  return { ok, strategy, rowCount, provenance, reason };
}

/** Parse a JSON object reason; non-objects and malformed JSON yield null. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Execution id of an n8n Error Trigger payload, looked up where it actually
 * appears (nested under execution, or flat). Callers fall back to a body hash.
 */
function executionIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const execution = record.execution;
  if (typeof execution === "object" && execution !== null) {
    const id = (execution as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") return id;
  }
  for (const key of ["executionId", "execution_id", "id"] as const) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Dashboard gate: when DASHBOARD_TOKEN is set (non-blank), mutations require
 * an exact `Authorization: Bearer <token>` match; unset means open locally.
 */
function isAuthorized(c: Context, settings: Settings): boolean {
  if (settings.dashboardToken === undefined) return true;
  return c.req.header("authorization") === `Bearer ${settings.dashboardToken}`;
}

/**
 * Build the receiver routes over an explicit store and settings pair, so
 * tests can inject `:memory:` stores while the module-level `app` singleton
 * below keeps the default file-backed wiring for `main()`.
 */
export function createApp({ store, settings, orchestrator, fetchFn }: CreateAppOptions): Hono {
  const app = new Hono();

  // Telegram approval callbacks go through the orchestrator (the only
  // writer) so traces and snapshots stay consistent. The inert LLM never
  // runs here: approve/reject touch only the store and the workflow map.
  const inertLlm: LLMPort = {
    name: "receiver",
    mode: "mock",
    submit_verdict: async () => {
      throw new Error("receiver: LLM unavailable on the webhook path");
    },
  };
  const telegramOrchestrator: Orchestrator =
    orchestrator ?? createOrchestrator({ store, llm: inertLlm, settings });
  const telegramFetchFn = typeof fetchFn === "function" ? fetchFn : undefined;

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/error-hook", async (c) => {
    const rawBody = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Pinned contract: malformed JSON is a 400, never a 500, never a hang.
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    // Idempotent per execution id; payloads without one dedupe by body hash, so
    // n8n retries of the same failure never duplicate events.
    const eventId =
      executionIdFromPayload(payload) ?? createHash("sha256").update(rawBody).digest("hex");
    const { created } = store.insertEvent({ executionId: eventId, payload });
    // Pinned response shape: {"ok":true,"event_id":"<id>","created":<bool>}.
    return c.json({ ok: true, event_id: eventId, created });
  });

  app.post("/telegram/webhook", async (c) => {
    const rawBody = await c.req.text();
    let update: unknown;
    try {
      update = JSON.parse(rawBody);
    } catch {
      // Pinned contract: malformed JSON is a 400, never a 500, never a hang.
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    try {
      await handleTelegramUpdate(
        update,
        {
          approve: (eventId: string) => telegramOrchestrator.approve(eventId),
          reject: (eventId: string) => telegramOrchestrator.reject(eventId),
        },
        {
          settings,
          ...(telegramFetchFn !== undefined ? { fetchFn: telegramFetchFn } : {}),
        },
      );
    } catch {
      // Orchestrator throws (unknown event, wrong status) still answer 200:
      // Telegram retries on non-2xx, and the stored status is unchanged.
    }
    return c.json({ ok: true });
  });

  app.get("/repair-events", (c) => {
    const statusFilter = c.req.query("status");
    const rows =
      statusFilter === undefined ? store.listEvents() : store.listEventsByStatus(statusFilter);
    return c.json({ events: rows.map(eventJson) });
  });

  app.get("/repair-events/:id", (c) => {
    const id = c.req.param("id");
    // The route always binds :id; the guard only satisfies the typechecker.
    if (id === undefined) return c.json({ error: "event not found" }, 404);
    const row = store.getEvent(id);
    // Pinned contract: unknown event id -> 404, never 5xx.
    if (row === null) return c.json({ error: "event not found" }, 404);
    // Detail-only extras: tier + verification log. The list/action shapes
    // stay pinned; these fields are additive and never alter the base keys.
    return c.json({
      ...eventJson(row),
      tier: tierOf(store, id),
      verification: verificationOf(store, id),
    });
  });

  // Dashboard mutations behind the token gate. The shared orchestrator is
  // the writer (issue #26): approve promotes the parked restore via the
  // workflow client, reject/revert flip the stored status. Every action
  // still succeeds on any stored status (the issue pins only 200/401/404);
  // the status write plus a stage:"outcome" decision row mirrors the orchestrator's recordDecision
  // convention so the orchestrator can take over the same rows later.
  // An orchestrator refusal (e.g. approve from `received`, revert with no
  // snapshot) falls back to the bare store write and still reports 200.
  const action =
    (kind: "approve" | "reject" | "revert", status: string, verdict: string, reason: string) =>
    async (c: Context): Promise<Response> => {
      if (!isAuthorized(c, settings)) return c.json({ error: "unauthorized" }, 401);
      const id = c.req.param("id");
      if (id === undefined) return c.json({ error: "event not found" }, 404);
      if (store.getEvent(id) === null) return c.json({ error: "event not found" }, 404);
      try {
        if (kind === "approve") await telegramOrchestrator.approve(id);
        else if (kind === "reject") await telegramOrchestrator.reject(id);
        else await telegramOrchestrator.revert(id);
      } catch {
        try {
          store.insertDecision({ eventId: id, stage: "outcome", verdict, reason, confidence: 1 });
        } catch {
          // Decision rows are best-effort; the mutation still reports 200.
        }
        const fallback = store.updateEventStatus(id, status);
        if (fallback === null) return c.json({ error: "not found" }, 404);
        return c.json(eventJson(fallback));
      }
      const updated = store.getEvent(id);
      if (updated === null) return c.json({ error: "event not found" }, 404);
      return c.json(eventJson(updated));
    };

  app.post("/repair-events/:id/approve", action("approve", "promoted", "promoted", "approved via dashboard"));
  app.post("/repair-events/:id/reject", action("reject", "rejected", "rejected", "rejected via dashboard"));
  app.post("/repair-events/:id/revert", action("revert", "reverted", "reverted", "reverted via dashboard"));

  // Human-friendly dashboard (issue #44): server-rendered htmx page plus
  // feed/detail fragments. Registered before serveStatic so the fragments
  // are never shadowed by static files.
  app.get("/dashboard/feed", (c) => c.html(renderFeed(store)));

  app.get("/dashboard/events/:id", (c) => {
    const id = c.req.param("id");
    if (id === undefined) return c.html(`<div class="error"><p>event not found</p></div>`, 404);
    const html = renderDetail(store, id);
    if (html === null) return c.html(`<div class="error"><p>event not found</p></div>`, 404);
    return c.html(html);
  });

  // Dashboard entry: dynamic server-rendered page. Static files still serve
  // other assets via serveStatic below; GET / itself is always the live page.
  app.get("/", (c) => c.html(renderIndex(store, settings)));

  // Static dashboard assets; registered after every API route so API shapes
  // are never shadowed. Missing files fall through to the JSON notFound below.
  for (const root of STATIC_ROOTS) {
    if (existsSync(root)) app.use("/*", serveStatic({ root }));
  }

  // Pinned contract: unknown routes are JSON 404s, never 5xx or HTML.
  app.notFound((c) => c.json({ error: "not found" }, 404));
  // Genuine handler throws are JSON 500s; malformed JSON still takes the 400 path above.
  app.onError((_err, c) => c.json({ error: "internal error" }, 500));

  return app;
}

const defaultSettings = loadSettings();

/**
 * Default wiring: real SQLite file (Settings.dbPath, default kintsugi.db) so
 * existing imports and `main()` keep working; tests use `createApp` with
 * `:memory:` stores for isolation.
 */
export const app = createApp({
  store: openStore(defaultSettings.dbPath ?? "kintsugi.db"),
  settings: defaultSettings,
});

export function main(): ReturnType<typeof serve> {
  // Single env parse point: the receiver binds settings.port so the bound
  // server port can never drift from the pinned PORT/KINTSUGI_PORT/8080
  // contract that lives in src/config/settings.ts.
  const { port } = loadSettings();
  const server = serve({ fetch: app.fetch, port });
  // The default host is all interfaces; readiness probe hits 127.0.0.1.
  console.log(`kintsugi receiver listening on port ${port}`);
  return server;
}

// Run the server only when executed directly (`node dist/src/receiver/app.js`),
// not when imported by tests or other modules. Node has no import.meta.main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
