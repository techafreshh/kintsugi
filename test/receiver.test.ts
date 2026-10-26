import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { app, resolvePort } from "../src/receiver/app.js";

describe("GET /healthz", () => {
  it("returns 200 with body exactly {\"ok\":true}", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("unknown routes", () => {
  it("returns 404 (never 5xx)", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});

describe("resolvePort", () => {
  const cases: Array<{
    name: string;
    env: Partial<Record<"PORT" | "KINTSUGI_PORT", string | undefined>>;
    expected: number;
  }> = [
    { name: "no env -> 8080", env: {}, expected: 8080 },
    { name: "PORT wins", env: { PORT: "9911" }, expected: 9911 },
    { name: "KINTSUGI_PORT alone is honored", env: { KINTSUGI_PORT: "9922" }, expected: 9922 },
    { name: "both set -> PORT wins", env: { PORT: "9911", KINTSUGI_PORT: "9922" }, expected: 9911 },
    { name: "invalid PORT falls through to KINTSUGI_PORT", env: { PORT: "not-a-port", KINTSUGI_PORT: "9922" }, expected: 9922 },
    { name: "blank PORT falls through to default", env: { PORT: "  " }, expected: 8080 },
    { name: "out-of-range PORT falls through", env: { PORT: "70000", KINTSUGI_PORT: "9922" }, expected: 9922 },
  ];
  for (const { name, env, expected } of cases) {
    it(name, () => {
      expect(resolvePort(env)).toBe(expected);
    });
  }
});

describe("real loopback serve", () => {
  // Proves the serve({ fetch: app.fetch }) wiring end-to-end over a real
  // socket, which in-process app.request() cannot.
  const servers: ServerType[] = [];

  afterAll(async () => {
    for (const server of servers) {
      // serve() returns a union typed around http.Server at runtime; the
      // runtime object always carries closeAllConnections.
      (server as HttpServer).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves /healthz with the pinned body on an ephemeral port", async () => {
    const server = serve({ fetch: app.fetch, port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no tcp address");
    const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});
