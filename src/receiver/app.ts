import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";

export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Port binding precedence per the machine contract: PORT, then KINTSUGI_PORT,
 * then 8080. Blank or non-integer/out-of-range values fall through to the
 * next source instead of crashing startup.
 */
export function resolvePort(
  env: Partial<Record<"PORT" | "KINTSUGI_PORT", string | undefined>> = process.env,
): number {
  for (const value of [env.PORT, env.KINTSUGI_PORT]) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const port = Number(trimmed);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return 8080;
}

export function main(): ReturnType<typeof serve> {
  const port = resolvePort();
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
