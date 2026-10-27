import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static contract test (issue #22): proves the container demo files pin the
 * required shape with zero docker dependency — plain text reads plus a tiny
 * indentation-based service splitter, so the test runs in CI exactly as it
 * does on an operator box.
 */

const composeText = readFileSync("docker-compose.yml", "utf8");
const dockerfileText = readFileSync("Dockerfile", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  bin?: Record<string, string>;
  engines?: Record<string, string>;
};

/**
 * Split the top-level `services:` mapping into per-service blocks. Service
 * headers are exactly two-space indented (`  api:`); a block runs until the
 * next service header or the next column-zero line.
 */
function serviceBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = text.split("\n");
  let current: string | null = null;
  let start = 0;
  const flush = (end: number): void => {
    if (current !== null) blocks.set(current, lines.slice(start, end).join("\n"));
    current = null;
  };
  let inServices = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) inServices = /^services:\s*$/.test(line);
    if (!inServices) continue;
    const header = /^  (\S+):\s*$/.exec(line);
    if (header !== null) {
      flush(i);
      current = header[1] as string;
      start = i;
    } else if (/^\S/.test(line)) {
      flush(i);
    }
  }
  flush(lines.length);
  return blocks;
}

const services = serviceBlocks(composeText);

function service(name: string): string {
  const block = services.get(name);
  if (block === undefined) throw new Error(`test: service "${name}" missing from docker-compose.yml`);
  return block;
}

describe("docker-compose services", () => {
  it("defines api, worker, mock-upstream, and n8n services", () => {
    for (const name of ["api", "worker", "mock-upstream", "n8n"]) {
      expect(services.has(name), `service "${name}" defined`).toBe(true);
    }
  });

  it("defines both dev and deploy profiles", () => {
    expect(composeText).toContain("dev");
    expect(composeText).toContain("deploy");
  });

  it("includes worker at minimum (docker compose config --services)", () => {
    expect(services.has("worker")).toBe(true);
  });

  it("api publishes its port on 127.0.0.1 (loopback-only)", () => {
    expect(service("api")).toContain("127.0.0.1");
  });

  it("mock-upstream command runs the mock binary from the one image", () => {
    const block = service("mock-upstream");
    expect(block).toContain("mock-upstream");
    expect(block).toContain("build: .");
  });

  it("n8n is dev-profile only (never deploy)", () => {
    const block = service("n8n");
    expect(block).toContain("dev");
    expect(block).not.toContain("deploy");
    expect(block).toContain("n8nio/n8n");
  });

  it("api and worker carry both profiles and join the external web_gateway network", () => {
    for (const name of ["api", "worker"]) {
      const block = service(name);
      expect(block).toContain("dev");
      expect(block).toContain("deploy");
      expect(block).toContain("web_gateway");
    }
    expect(composeText).toContain("web_gateway");
    expect(composeText).toMatch(/external:\s*true/);
  });

  it("api port mapping pins the loopback contract", () => {
    expect(service("api")).toContain("127.0.0.1:${PORT:-8080}:8080");
  });
});

describe("Dockerfile", () => {
  it("builds from node:22 (builder) to node:22-slim (runner)", () => {
    expect(dockerfileText).toContain("FROM node:22");
    expect(dockerfileText).toContain("FROM node:22-slim");
  });

  it("pins no node tag above 22 anywhere", () => {
    expect(dockerfileText).not.toMatch(/node:(2[3-9]|[3-9]\d)/);
  });

  it("defaults to serving the API via the kintsugi bin", () => {
    expect(dockerfileText).toContain('CMD ["kintsugi", "api"]');
  });
});

describe("package.json", () => {
  it("exposes kintsugi and mock-upstream bins", () => {
    expect(packageJson.bin?.["kintsugi"]).toBe("dist/src/cli.js");
    const bins = Object.values(packageJson.bin ?? {});
    expect(bins.some((target) => target.includes("mockupstream"))).toBe(true);
  });

  it("engines stays on node 22 (nothing above 22)", () => {
    expect(packageJson.engines?.["node"]).toBeDefined();
    expect(packageJson.engines?.["node"] as string).not.toMatch(/2[3-9]|[3-9]\d/);
  });
});
