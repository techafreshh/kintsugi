import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static contract test (issue #27): pins the final README's required shape
 * with zero external dependencies — a plain text read plus string/regex
 * assertions, mirroring the `test/docker-compose.test.ts` idiom, so the
 * setup guide, architecture diagram, tier table, and security section cannot
 * regress silently.
 */

const readme = readFileSync("README.md", "utf8");

/** Required section keywords; each must appear in a markdown heading. */
const REQUIRED_HEADINGS = [
  "Quickstart",
  "Architecture",
  "Tiers",
  "Security",
  "Configuration",
  "API",
  "Dashboard",
  "Troubleshooting",
  "License",
] as const;

function headingFor(keyword: string): boolean {
  return new RegExp(`^#{1,3}\\s.*${keyword}`, "mi").test(readme);
}

/** Numbered run steps live in the Quickstart section only; prose sub-bullets do not count. */
function quickstartSteps(): string[] {
  const section = readme.split(/^##\s+Quickstart\s*$/m)[1]?.split(/^##\s+/m)[0] ?? "";
  return section.split("\n").filter((line) => /^\d+\.\s/.test(line.trim()));
}

describe("README required sections", () => {
  for (const keyword of REQUIRED_HEADINGS) {
    it(`has a ${keyword} heading`, () => {
      expect(headingFor(keyword), `README heading for "${keyword}"`).toBe(true);
    });
  }
});

describe("README pinned contract", () => {
  it('pins the health shape {"ok":true} verbatim', () => {
    expect(readme).toContain('{"ok":true}');
  });

  it("documents the port precedence wording (PORT, KINTSUGI_PORT, 8080)", () => {
    expect(readme).toContain("PORT");
    expect(readme).toContain("KINTSUGI_PORT");
    expect(readme).toContain("8080");
  });

  it("documents the dashboard token gate", () => {
    expect(readme).toContain("DASHBOARD_TOKEN");
  });

  it("keeps the numbered quickstart to at most 10 steps", () => {
    const steps = quickstartSteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(10);
  });

  it("never requires node above 22", () => {
    expect(readme).not.toMatch(/node:\s*24/i);
    expect(readme).not.toMatch(/node\s+24/i);
    expect(readme).not.toMatch(/engines.*2[3-9]/i);
  });
});
