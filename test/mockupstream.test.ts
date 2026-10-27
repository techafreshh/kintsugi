import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { createChaosApp, validateChaosBody } from "../src/mockupstream/app.js";

/** Fresh isolated app per test so countdown state never leaks across cases. */
function makeApp(): Hono {
  return createChaosApp();
}

const postChaos = (target: Hono, body: string) =>
  target.request("/chaos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("default state", () => {
  it("boots as {\"schema\":\"old\",\"fail_next\":0,\"fail_status\":null}", async () => {
    const res = await makeApp().request("/chaos");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ schema: "old", fail_next: 0, fail_status: null });
  });
});

describe("schema modes", () => {
  it('POST {"schema":"new"} makes the first record expose userId/userName', async () => {
    const target = makeApp();
    const posted = await postChaos(target, JSON.stringify({ schema: "new" }));
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ schema: "new" });
    const res = await target.request("/api/users");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(Object.keys(body[0] as Record<string, unknown>).sort()).toEqual(["userId", "userName"]);
  });

  it('POST {"schema":"old"} makes the first record expose id/name', async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ schema: "new" }));
    const posted = await postChaos(target, JSON.stringify({ schema: "old" }));
    expect(posted.status).toBe(200);
    const res = await target.request("/api/users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Object.keys(body[0] as Record<string, unknown>).sort()).toEqual(["id", "name"]);
  });
});

describe("failure countdown", () => {
  it("fail_next:2/fail_status:429 yields 429, 429, then 200", async () => {
    const target = makeApp();
    const posted = await postChaos(target, JSON.stringify({ fail_next: 2, fail_status: 429 }));
    expect(posted.status).toBe(200);
    const first = await target.request("/api/users");
    expect(first.status).toBe(429);
    const second = await target.request("/api/users");
    expect(second.status).toBe(429);
    const third = await target.request("/api/users");
    expect(third.status).toBe(200);
  });

  it("failure responses carry a JSON error body", async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ fail_next: 1, fail_status: 503 }));
    const res = await target.request("/api/users");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "chaos failure", status: 503 });
  });

  it("exhausted state reads exactly {\"schema\":\"old\",\"fail_next\":0,\"fail_status\":null}", async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ fail_next: 2, fail_status: 429 }));
    await target.request("/api/users");
    await target.request("/api/users");
    await target.request("/api/users");
    const res = await target.request("/chaos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schema: "old", fail_next: 0, fail_status: null });
  });

  it("GET /chaos never consumes the countdown", async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ fail_next: 1, fail_status: 429 }));
    await target.request("/chaos");
    await target.request("/chaos");
    const peaked = (await (await target.request("/chaos")).json()) as {
      fail_next: number;
    };
    expect(peaked.fail_next).toBe(1);
    expect((await target.request("/api/users")).status).toBe(429);
    expect((await target.request("/api/users")).status).toBe(200);
  });
});

describe("determinism", () => {
  it("same request twice yields byte-identical bodies", async () => {
    const target = makeApp();
    const first = await (await target.request("/api/users")).text();
    const second = await (await target.request("/api/users")).text();
    expect(second).toBe(first);
  });

  it("new-schema bodies are byte-identical across repeats", async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ schema: "new" }));
    const first = await (await target.request("/api/users")).text();
    const second = await (await target.request("/api/users")).text();
    expect(second).toBe(first);
    expect(first).toContain("userId");
  });
});

describe("POST /chaos validation", () => {
  it("returns 400 JSON on malformed JSON (never 500)", async () => {
    const res = await postChaos(makeApp(), "{broken");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 400 JSON for bad schema/fail_next/fail_status values", async () => {
    const target = makeApp();
    for (const body of [
      JSON.stringify({ schema: "v3" }),
      JSON.stringify({ schema: 42 }),
      JSON.stringify({ fail_next: -1 }),
      JSON.stringify({ fail_next: 1.5 }),
      JSON.stringify({ fail_next: "2" }),
      JSON.stringify({ fail_status: 200 }),
      JSON.stringify({ fail_status: 99 }),
      JSON.stringify({ fail_status: "429" }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify("chaos"),
    ]) {
      const res = await postChaos(target, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("applies partial updates and ignores unknown fields", async () => {
    const target = makeApp();
    const res = await postChaos(
      target,
      JSON.stringify({ schema: "new", unknown_field: "ignored" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schema: "new", fail_next: 0, fail_status: null });
  });

  it("fail_next:0 clears a pending failure", async () => {
    const target = makeApp();
    await postChaos(target, JSON.stringify({ fail_next: 2, fail_status: 429 }));
    const cleared = await postChaos(target, JSON.stringify({ fail_next: 0 }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ schema: "old", fail_next: 0, fail_status: null });
    expect((await target.request("/api/users")).status).toBe(200);
  });
});

describe("validateChaosBody", () => {
  const cases: Array<{ name: string; body: unknown; ok: boolean }> = [
    { name: "empty object is a valid partial update", body: {}, ok: true },
    { name: "schema old is valid", body: { schema: "old" }, ok: true },
    { name: "schema new is valid", body: { schema: "new" }, ok: true },
    { name: "unknown schema is invalid", body: { schema: "v2" }, ok: false },
    { name: "fail_next zero is valid", body: { fail_next: 0 }, ok: true },
    { name: "fail_next positive int is valid", body: { fail_next: 3 }, ok: true },
    { name: "fail_next negative is invalid", body: { fail_next: -1 }, ok: false },
    { name: "fail_next float is invalid", body: { fail_next: 1.5 }, ok: false },
    { name: "fail_next string is invalid", body: { fail_next: "2" }, ok: false },
    { name: "fail_status 429 is valid", body: { fail_status: 429 }, ok: true },
    { name: "fail_status null is valid (clear)", body: { fail_status: null }, ok: true },
    { name: "fail_status 200 is invalid", body: { fail_status: 200 }, ok: false },
    { name: "fail_status 600 is invalid", body: { fail_status: 600 }, ok: false },
    { name: "array body is invalid", body: [], ok: false },
    { name: "null body is invalid", body: null, ok: false },
  ];
  for (const { name, body, ok } of cases) {
    it(name, () => {
      expect(validateChaosBody(body).ok).toBe(ok);
    });
  }
});

describe("unknown routes", () => {
  it("returns 404 JSON (never 5xx or HTML)", async () => {
    const res = await makeApp().request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("real loopback serve", () => {
  // Proves the serve({ fetch: app.fetch }) wiring end-to-end over a real
  // socket, which in-process app.request() cannot.
  const servers: ServerType[] = [];

  afterAll(async () => {
    for (const server of servers) {
      (server as HttpServer).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves /chaos and /api/users on an ephemeral port", async () => {
    const isolated = makeApp();
    const server = serve({ fetch: isolated.fetch, port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no tcp address");
    const chaos = await fetch(`http://127.0.0.1:${address.port}/chaos`);
    expect(chaos.status).toBe(200);
    expect(await chaos.json()).toEqual({ schema: "old", fail_next: 0, fail_status: null });
    const users = await fetch(`http://127.0.0.1:${address.port}/api/users`);
    expect(users.status).toBe(200);
    const body = (await users.json()) as Array<Record<string, unknown>>;
    expect(Object.keys(body[0] as Record<string, unknown>).sort()).toEqual(["id", "name"]);
  });
});
