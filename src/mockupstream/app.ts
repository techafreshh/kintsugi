import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadSettings } from "../config/settings.js";

/** Schema mode of the mock user records. */
export type ChaosSchema = "old" | "new";

/** Mutable in-memory countdown state driving schema drift and failures. */
export interface ChaosState {
  schema: ChaosSchema;
  fail_next: number;
  fail_status: number | null;
}

/** Options-object wiring so tests can seed state while `app` keeps defaults. */
export interface CreateChaosAppOptions {
  initialState?: Partial<ChaosState> | undefined;
}

/** Default state on boot, before any `POST /chaos`. */
export const DEFAULT_CHAOS_STATE: ChaosState = {
  schema: "old",
  fail_next: 0,
  fail_status: null,
};

/** Fresh copy of the default state, optionally overridden per field. */
export function createChaosState(init: Partial<ChaosState> = {}): ChaosState {
  return {
    schema: init.schema ?? DEFAULT_CHAOS_STATE.schema,
    fail_next: init.fail_next ?? DEFAULT_CHAOS_STATE.fail_next,
    fail_status: init.fail_status ?? DEFAULT_CHAOS_STATE.fail_status,
  };
}

/**
 * Pure validation for `POST /chaos` bodies: partial update, so omitted fields
 * are fine; present fields must satisfy `schema` in {"old","new"},
 * `fail_next` a non-negative integer, `fail_status` null or an integer
 * 400-599. Never throws.
 */
export function validateChaosBody(body: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid chaos body" };
  }
  const record = body as Record<string, unknown>;
  if (record.schema !== undefined && record.schema !== "old" && record.schema !== "new") {
    return { ok: false, error: "invalid schema" };
  }
  if (record.fail_next !== undefined) {
    const n = record.fail_next;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: "invalid fail_next" };
    }
  }
  if (record.fail_status !== undefined && record.fail_status !== null) {
    const s = record.fail_status;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 400 || s > 599) {
      return { ok: false, error: "invalid fail_status" };
    }
  }
  return { ok: true };
}

/** Fixed seed records; no timestamps, randomness, or Date usage anywhere. */
export const SEED_USERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "u1", name: "Ada Lovelace" },
  { id: "u2", name: "Alan Turing" },
  { id: "u3", name: "Grace Hopper" },
];

/** Map one seed record into the active schema shape with stable key order. */
export function toSchemaRecord(
  user: { id: string; name: string },
  schema: ChaosSchema,
): { id: string; name: string } | { userId: string; userName: string } {
  if (schema === "new") return { userId: user.id, userName: user.name };
  return { id: user.id, name: user.name };
}

/** Snapshot the mutable state into a fresh JSON-safe object with fixed keys. */
function snapshotState(state: ChaosState): ChaosState {
  return { schema: state.schema, fail_next: state.fail_next, fail_status: state.fail_status };
}

/**
 * Build the mock upstream routes over one mutable `ChaosState`, so tests can
 * spin up isolated apps while the module-level `app` singleton below keeps
 * the default wiring for `main()`.
 */
export function createChaosApp(options: CreateChaosAppOptions = {}): Hono {
  const state = createChaosState(options.initialState ?? {});
  const app = new Hono();

  app.get("/api/users", (c) => {
    // Only this route consumes the failure countdown; control-plane routes
    // never decrement.
    if (state.fail_next > 0) {
      const status = state.fail_status ?? 500;
      state.fail_next -= 1;
      if (state.fail_next === 0) state.fail_status = null;
      return c.json({ error: "chaos failure", status }, status as 500);
    }
    const records = SEED_USERS.map((user) => toSchemaRecord(user, state.schema));
    return c.json(records);
  });

  // Read-only peek at the countdown; never consumes it.
  app.get("/chaos", (c) => c.json(snapshotState(state)));

  app.post("/chaos", async (c) => {
    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = rawBody === "" ? {} : JSON.parse(rawBody);
    } catch {
      // Pinned contract: malformed JSON is a 400, never a 500, never a hang.
      return c.json({ error: "invalid JSON" }, 400);
    }
    const checked = validateChaosBody(body);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const record = body as Record<string, unknown>;
    // Partial update: omitted fields keep their values, unknown fields ignored.
    if (record.schema !== undefined) state.schema = record.schema as ChaosSchema;
    const failStatusPresent = record.fail_status !== undefined;
    if (record.fail_next !== undefined) state.fail_next = record.fail_next as number;
    if (failStatusPresent) state.fail_status = record.fail_status as number | null;
    // fail_next: 0 clears any pending failure unless a new fail_status rode
    // along in the same body.
    if (state.fail_next === 0 && !failStatusPresent) state.fail_status = null;
    return c.json(snapshotState(state));
  });

  // Pinned contract: unknown routes are JSON 404s, never 5xx or HTML.
  app.notFound((c) => c.json({ error: "not found" }, 404));
  // Genuine handler throws are JSON 500s; validation still takes the 400 path above.
  app.onError((_err, c) => c.json({ error: "internal error" }, 500));

  return app;
}

/** Default wiring: fresh default chaos state for `main()`. */
export const app = createChaosApp();

export function main(): ReturnType<typeof serve> {
  // Single env parse point: the mock binds settings.port so the bound port
  // never drifts from the pinned PORT/KINTSUGI_PORT/8080 contract in
  // src/config/settings.ts; compose assigns the distinct port later.
  const { port } = loadSettings();
  const server = serve({ fetch: app.fetch, port });
  console.log(`kintsugi mock upstream listening on port ${port}`);
  return server;
}

// Run the server only when executed directly
// (`node dist/src/mockupstream/app.js`), not when imported by tests or other
// modules. Node has no import.meta.main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
