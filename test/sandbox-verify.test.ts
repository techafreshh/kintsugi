import { describe, expect, it } from "vitest";
import { deriveExpectations, extractRows, verify } from "../src/sandbox/verify.js";

function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, total: 100 }));
}

describe("sandbox verifier", () => {
  it("reports a record-count mismatch with expected 12 and actual 10", async () => {
    const result = verify({ rows: rows(10) }, { recordCount: 12 });
    expect(result.ok).toBe(false);
    const mismatch = result.failures.find((failure) => failure.check === "record-count");
    expect(mismatch).toBeDefined();
    expect(mismatch?.expected).toBe(12);
    expect(mismatch?.actual).toBe(10);
  });

  it("reports a null-rate failure when every field is null against a 20% ceiling", async () => {
    const result = verify(
      { rows: [{ a: null, b: null }] },
      { recordCount: 1, maxNullRate: 0.2, fieldTypes: { a: "string", b: "string" } },
    );
    expect(result.ok).toBe(false);
    const nullRate = result.failures.find((failure) => failure.check === "null-rate");
    expect(nullRate).toBeDefined();
    expect(nullRate?.expected).toBe(0.2);
  });

  it("passes a green replay with no failures", async () => {
    const lastGood = { rows: rows(3) };
    const expectations = deriveExpectations(lastGood);
    expect(expectations.recordCount).toBe(3);
    const result = verify({ rows: rows(3) }, expectations);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("reads n8n runData execution shapes", async () => {
    const execution = {
      data: {
        resultData: {
          runData: {
            Set: [{ json: { id: 1 } }, { json: { id: 2 } }],
          },
        },
      },
    };
    expect(extractRows(execution)).toEqual([{ id: 1 }, { id: 2 }]);
    const result = verify(execution, { recordCount: 2 });
    expect(result.ok).toBe(true);
  });
});
