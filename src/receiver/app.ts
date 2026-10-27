import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { loadSettings, type Settings } from "../config/settings.js";
import { openStore, type Store, type StoredRepairEvent } from "../store/store.js";

/** Static roots tried in order: built output first, repo source fallback. */
const STATIC_ROOTS = ["dist/public", "public"] as const;

export interface CreateAppOptions {
  store: Store;
  settings: Settings;
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
    status: row.status,
    received_at: row.receivedAt,
    payload: row.payload,
  };
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
export function createApp({ store, settings }: CreateAppOptions): Hono {
  const app = new Hono();

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
    return c.json(eventJson(row));
  });

  // Dashboard mutations behind the token gate. Every action succeeds on any
  // stored status (the issue pins only 200/401/404); the status write plus a
  // stage:"outcome" decision row mirror the orchestrator's recordDecision
  // convention so the orchestrator can take over the same rows later.
  const action =
    (status: string, verdict: string, reason: string) =>
    (c: Context): Response => {
      if (!isAuthorized(c, settings)) return c.json({ error: "unauthorized" }, 401);
      const id = c.req.param("id");
      if (id === undefined) return c.json({ error: "event not found" }, 404);
      if (store.getEvent(id) === null) return c.json({ error: "event not found" }, 404);
      try {
        store.insertDecision({ eventId: id, stage: "outcome", verdict, reason, confidence: 1 });
      } catch {
        // Decision rows are best-effort; the mutation still reports 200.
      }
      const updated = store.updateEventStatus(id, status);
      if (updated === null) return c.json({ error: "event not found" }, 404);
      return c.json(eventJson(updated));
    };

  app.post("/repair-events/:id/approve", action("promoted", "promoted", "approved via dashboard"));
  app.post("/repair-events/:id/reject", action("rejected", "rejected", "rejected via dashboard"));
  app.post("/repair-events/:id/revert", action("reverted", "reverted", "reverted via dashboard"));

  // Dashboard entry: serve the built page when present, else a JSON 404 so the
  // API contract holds even before `npm run build` copies public/ to dist/.
  app.get("/", (c) => {
    for (const root of STATIC_ROOTS) {
      const file = join(root, "index.html");
      if (existsSync(file)) return c.html(readFileSync(file, "utf8"));
    }
    return c.json({ error: "not found" }, 404);
  });

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
