import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadSettings } from "../config/settings.js";
import { pathToFileURL } from "node:url";

export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Repair events held in memory, keyed by event id, until the SQLite store
 * (slicing item 3) replaces this without changing the pinned HTTP shapes.
 * /error-hook and /repair-events share this map within one process.
 */
interface RepairEvent {
  event_id: string;
  status: string;
  received_at: string;
  payload: unknown;
}

const repairEvents = new Map<string, RepairEvent>();

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
    executionIdFromPayload(payload) ??
    createHash("sha256").update(rawBody).digest("hex");
  const created = !repairEvents.has(eventId);
  if (created) {
    repairEvents.set(eventId, {
      event_id: eventId,
      status: "received",
      received_at: new Date().toISOString(),
      payload,
    });
  }
  // Pinned response shape: {"ok":true,"event_id":"<id>","created":<bool>}.
  return c.json({ ok: true, event_id: eventId, created });
});

app.get("/repair-events", (c) => {
  const statusFilter = c.req.query("status");
  const events = [...repairEvents.values()].filter(
    (event) => statusFilter === undefined || event.status === statusFilter,
  );
  return c.json({ events });
});

app.get("/repair-events/:id", (c) => {
  const event = repairEvents.get(c.req.param("id"));
  // Pinned contract: unknown event id -> 404, never 5xx.
  if (event === undefined) return c.json({ error: "event not found" }, 404);
  return c.json(event);
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
