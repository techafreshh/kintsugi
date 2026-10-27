import { describe, expect, it } from "vitest";
import { classifyTier } from "../src/pipeline/tier.js";

describe("acceptance: issue #13 tiers", () => {
  it("flags [] with no scope expansion -> flag-only", () => {
    expect(
      classifyTier({ flags: [], confidence: 0.9, scope: "none", reversible: false }),
    ).toBe("flag-only");
  });

  it("requiresApproval:true -> approve", () => {
    expect(
      classifyTier({
        flags: [],
        confidence: 0.9,
        scope: "none",
        reversible: false,
        requiresApproval: true,
      }),
    ).toBe("approve");
  });

  it("confidence 0.95 + affected-nodes-only + reversible:true with a safe flag -> auto-promote", () => {
    expect(
      classifyTier({
        flags: ["safe-value-fix"],
        confidence: 0.95,
        scope: "affected-nodes-only",
        reversible: true,
      }),
    ).toBe("auto-promote");
  });

  it("flags that is not a string array -> escalate without throwing", () => {
    expect(classifyTier({ flags: [42], confidence: 0.95 })).toBe("escalate");
    expect(classifyTier({ flags: "flags", confidence: 0.95 })).toBe("escalate");
    expect(classifyTier({ flags: null, confidence: 0.95 })).toBe("escalate");
  });
});

describe("escalate on doubt", () => {
  const cases: Array<{ name: string; verdict: unknown; expected: "escalate" }> = [
    {
      name: "unknown flag -> escalate",
      verdict: { flags: ["nope-unknown"], confidence: 0.95 },
      expected: "escalate",
    },
    {
      name: "mixed safe+approve flags conflict -> escalate",
      verdict: { flags: ["safe-value-fix", "touches-code"], confidence: 0.95 },
      expected: "escalate",
    },
    {
      name: "confidence 0.79 below threshold -> escalate",
      verdict: { flags: ["safe-value-fix"], confidence: 0.79, scope: "affected-nodes-only", reversible: true },
      expected: "escalate",
    },
    {
      name: "missing confidence -> escalate",
      verdict: { flags: ["safe-value-fix"], scope: "affected-nodes-only", reversible: true },
      expected: "escalate",
    },
    {
      name: "NaN confidence -> escalate",
      verdict: { flags: ["safe-value-fix"], confidence: NaN, scope: "affected-nodes-only", reversible: true },
      expected: "escalate",
    },
    {
      name: "scope expansion -> escalate",
      verdict: { flags: [], confidence: 0.95, scope: "expanded" },
      expected: "escalate",
    },
    {
      name: "null verdict -> escalate",
      verdict: null,
      expected: "escalate",
    },
    {
      name: "number verdict -> escalate",
      verdict: 42,
      expected: "escalate",
    },
    {
      name: "string verdict -> escalate",
      verdict: "x",
      expected: "escalate",
    },
    {
      name: "empty flags with expansion -> escalate",
      verdict: { flags: [], confidence: 0.95, scope: "other-workflow" },
      expected: "escalate",
    },
    {
      name: "safe flags without scoped reversible gates -> escalate",
      verdict: { flags: ["safe-value-fix"], confidence: 0.95, scope: "none", reversible: true },
      expected: "escalate",
    },
  ];
  for (const { name, verdict, expected } of cases) {
    it(name, () => {
      expect(classifyTier(verdict)).toBe(expected);
    });
  }
});

describe("approve and auto-promote edges", () => {
  it("any approve flag -> approve", () => {
    expect(classifyTier({ flags: ["touches-code"], confidence: 0.9 })).toBe("approve");
  });

  it("requiresApproval:true with safe scoped reversible flags stays approve", () => {
    expect(
      classifyTier({
        flags: ["safe-value-fix"],
        confidence: 0.95,
        scope: "affected-nodes-only",
        reversible: true,
        requiresApproval: true,
      }),
    ).toBe("approve");
  });

  it("unknown flag beats requiresApproval -> escalate", () => {
    expect(
      classifyTier({ flags: ["bogus-flag"], confidence: 0.95, requiresApproval: true }),
    ).toBe("escalate");
  });

  it("missing confidence beats requiresApproval -> escalate", () => {
    expect(classifyTier({ flags: [], requiresApproval: true })).toBe("escalate");
  });
});
