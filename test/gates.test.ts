import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ITERATION_ATTEMPTS,
  PROMOTION_SIMILARITY_THRESHOLD,
  iterationGate,
  patchReviewGate,
  promotionGate,
  resetIterationGate,
  triageGate,
} from "../src/pipeline/gates.js";

beforeEach(() => {
  resetIterationGate();
});

describe("acceptance: issue #14 promotion gate is escalate-only", () => {
  it("auto-promote + flag-only suggestion stays auto-promote with overruled:true", () => {
    const result = promotionGate({ classifierTier: "auto-promote", llmSuggestion: "flag-only" });
    expect(result.decision).toBe("auto-promote");
    expect(result.overruled).toBe(true);
  });

  it("auto-promote + flag-only suggestion via positional args stays auto-promote", () => {
    const result = promotionGate("auto-promote", "flag-only");
    expect(result.decision).toBe("auto-promote");
    expect(result.overruled).toBe(true);
  });

  it("auto-promote + flag-only verdict alias stays auto-promote with overruled:true", () => {
    const result = promotionGate({ tier: "auto-promote", verdict: "flag-only" });
    expect(result.decision).toBe("auto-promote");
    expect(result.overruled).toBe(true);
  });
});

describe("acceptance: issue #14 triage gate escalates on instability", () => {
  it("flag-only + needs-more-info verdict rises to at least approve", () => {
    const result = triageGate({
      classifierTier: "flag-only",
      llmSuggestion: { verdict: "needs_more_info", confidence: 0.5 },
    });
    expect(["approve", "escalate"]).toContain(result.decision);
    expect(result.overruled).toBe(false);
  });

  it("flag-only + low confidence rises to at least approve", () => {
    const result = triageGate("flag-only", { confidence: 0.5 });
    expect(["approve", "escalate"]).toContain(result.decision);
  });

  it("flag-only + unstable flag rises to at least approve", () => {
    const result = triageGate({
      tier: "flag-only",
      llmSuggestion: { flags: ["unstable"], confidence: 0.9 },
    });
    expect(["approve", "escalate"]).toContain(result.decision);
  });
});

describe("acceptance: issue #14 promotion gate enforces similarity", () => {
  it("auto-promote + below-threshold similarity returns approve or stricter", () => {
    const result = promotionGate({ classifierTier: "auto-promote", similarity: 0.3 });
    expect(["approve", "escalate"]).toContain(result.decision);
  });

  it("auto-promote + below-threshold patchSimilarity alias returns approve or stricter", () => {
    const result = promotionGate({ classifierTier: "auto-promote", patchSimilarity: 0.1 });
    expect(["approve", "escalate"]).toContain(result.decision);
  });

  it("auto-promote + at-threshold similarity keeps auto-promote", () => {
    const result = promotionGate({
      classifierTier: "auto-promote",
      similarity: PROMOTION_SIMILARITY_THRESHOLD,
    });
    expect(result.decision).toBe("auto-promote");
    expect(result.overruled).toBe(false);
  });

  it("auto-promote + failed verification returns approve or stricter", () => {
    const result = promotionGate({ classifierTier: "auto-promote", verified: false });
    expect(["approve", "escalate"]).toContain(result.decision);
  });
});

describe("acceptance: issue #14 iteration gate caps invocations", () => {
  it("3 unsuccessful verifications give up on the 3rd call with explicit attempts", () => {
    expect(iterationGate({ attempt: 1, verified: false }).decision).not.toBe("give-up");
    expect(iterationGate({ attempt: 2, verified: false }).decision).not.toBe("give-up");
    const third = iterationGate({ attempt: 3, verified: false });
    expect(third.decision).toBe("give-up");
  });

  it("3 unsuccessful verifications give up on the 3rd call via the fallback counter", () => {
    iterationGate({ verified: false });
    iterationGate({ verified: false });
    expect(iterationGate({ verified: false }).decision).toBe("give-up");
  });

  it("invocations stay capped at give-up after the budget is exhausted", () => {
    iterationGate({ attempt: 1, verified: false });
    iterationGate({ attempt: 2, verified: false });
    expect(iterationGate({ attempt: 3, verified: false }).decision).toBe("give-up");
    expect(iterationGate({ attempt: 4, verified: false }).decision).toBe("give-up");
    expect(iterationGate({ verified: false }).decision).toBe("give-up");
    expect(MAX_ITERATION_ATTEMPTS).toBe(3);
  });

  it("a successful verification resets the budget", () => {
    iterationGate({ verified: false });
    iterationGate({ verified: false });
    const success = iterationGate({ verified: true });
    expect(success.decision).not.toBe("give-up");
    iterationGate({ verified: false });
    iterationGate({ verified: false });
    expect(iterationGate({ verified: false }).decision).toBe("give-up");
  });
});

describe("overruled records loosening attempts", () => {
  it("patch-review approve + proceed keeps approve with overruled:true", () => {
    const result = patchReviewGate({ classifierTier: "approve", llmSuggestion: "proceed" });
    expect(result.decision).toBe("approve");
    expect(result.overruled).toBe(true);
  });

  it("triage escalate + approve suggestion keeps escalate with overruled:true", () => {
    const result = triageGate({ classifierTier: "escalate", llmSuggestion: "approve" });
    expect(result.decision).toBe("escalate");
    expect(result.overruled).toBe(true);
  });

  it("matching suggestion is not overruled", () => {
    const result = promotionGate({ classifierTier: "approve", llmSuggestion: "approve" });
    expect(result.decision).toBe("approve");
    expect(result.overruled).toBe(false);
  });

  it("escalating suggestion is not overruled", () => {
    const result = triageGate({ classifierTier: "flag-only", llmSuggestion: "escalate" });
    expect(result.decision).toBe("escalate");
    expect(result.overruled).toBe(false);
  });
});

describe("patch-review reject blocks the patch", () => {
  it("flag-only + reject rises to at least approve", () => {
    const result = patchReviewGate({ classifierTier: "flag-only", llmSuggestion: "reject" });
    expect(["approve", "escalate"]).toContain(result.decision);
  });

  it("approve + reject rises to escalate", () => {
    const result = patchReviewGate({ classifierTier: "approve", llmSuggestion: "reject" });
    expect(result.decision).toBe("escalate");
  });
});

describe("alias-shape tolerance", () => {
  it("baseTier + suggestion aliases behave like classifierTier + llmSuggestion", () => {
    const result = promotionGate({ baseTier: "auto-promote", suggestion: "flag-only" });
    expect(result.decision).toBe("auto-promote");
    expect(result.overruled).toBe(true);
  });

  it("llmVerdict alias carries the suggestion", () => {
    const result = triageGate({ classifierTier: "flag-only", llmVerdict: "escalate" });
    expect(result.decision).toBe("escalate");
    expect(result.overruled).toBe(false);
  });

  it("bare tier string with no suggestion passes through", () => {
    expect(promotionGate("auto-promote")).toMatchObject({
      decision: "auto-promote",
      overruled: false,
    });
  });

  it("classifier verdict-shaped output derives its own tier", () => {
    const result = triageGate({ flags: [], confidence: 0.9, scope: "none", reversible: false });
    expect(result.decision).toBe("flag-only");
    expect(result.overruled).toBe(false);
  });
});

describe("escalate on doubt", () => {
  const cases: Array<{ name: string; input: unknown }> = [
    { name: "null", input: null },
    { name: "number", input: 42 },
    { name: "unknown string", input: "x" },
    { name: "array", input: [] },
    { name: "empty object", input: {} },
    { name: "unknown tier", input: { classifierTier: "bogus" } },
    { name: "unparseable suggestion", input: { classifierTier: "flag-only", llmSuggestion: 42 } },
    { name: "unknown suggestion string", input: { classifierTier: "flag-only", llmSuggestion: "maybe" } },
  ];
  for (const { name, input } of cases) {
    it(`triage ${name} escalates without throwing`, () => {
      expect(triageGate(input).decision).toBe("escalate");
    });
    it(`patch-review ${name} escalates without throwing`, () => {
      const result = patchReviewGate(input);
      expect(result.decision).toBe("escalate");
      expect(result.overruled).toBe(false);
    });
    it(`promotion ${name} escalates without throwing`, () => {
      expect(promotionGate(input).decision).toBe("escalate");
    });
  }

  it("iteration garbage escalates without throwing", () => {
    resetIterationGate();
    expect(iterationGate(null).decision).toBe("escalate");
    resetIterationGate();
    expect(iterationGate(42).decision).toBe("escalate");
    resetIterationGate();
    expect(iterationGate("x").decision).toBe("escalate");
  });
});
