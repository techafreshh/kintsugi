import { describe, expect, it } from "vitest";
import { redact, redactWorkflow } from "../src/security/redact.js";

describe("redact", () => {
  it("redacts keyed password assignments while preserving the rest of the line", () => {
    // Issue acceptance: Cyrillic M (\u041C) stays put; only the secret value
    // is replaced.
    const result = redact("\u041Cy key: password='hunter2hunter2'");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("hunter2hunter2");
    expect(result).toContain("\u041Cy key: password=");
  });

  const cases: Array<{
    name: string;
    input: string;
    secret: string;
    expectChange: boolean;
  }> = [
    {
      name: 'JSON apiKey field is redacted',
      input: '"apiKey": "real-secret-value-123"',
      secret: "real-secret-value-123",
      expectChange: true,
    },
    {
      name: "api_key= bare assignment is redacted",
      input: "api_key=sk-abcdefghijklmnop1234",
      secret: "sk-abcdefghijklmnop1234",
      expectChange: true,
    },
    {
      name: "Bearer header value is redacted",
      input: "Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      secret: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expectChange: true,
    },
    {
      name: "authorization: Bearer never strands the raw token",
      input: "authorization: Bearer supersecrettoken99",
      secret: "supersecrettoken99",
      expectChange: true,
    },
    {
      name: "JWT is redacted bare",
      input:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      secret: "eyJhbGciOiJIUzI1NiJ9",
      expectChange: true,
    },
    {
      name: "unknown key with long mixed value is redacted (entropy rule, JSON)",
      input: '"creds":"a1b2c3d4e5f6g7h8i9j0klmn"',
      secret: "a1b2c3d4e5f6g7h8i9j0klmn",
      expectChange: true,
    },
    {
      name: "unknown key with long mixed value is redacted (entropy rule, bare)",
      input: "creds=a1b2c3d4e5f6g7h8i9j0klmn",
      secret: "a1b2c3d4e5f6g7h8i9j0klmn",
      expectChange: true,
    },
    {
      name: "secret parameter inside a URL is still redacted by the keyed rule",
      input: "GET https://api.example.com/v1?api_key=zzz-secret-999999",
      secret: "zzz-secret-999999",
      expectChange: true,
    },
    {
      name: "scheme:// URL values survive the entropy rule (JSON)",
      input: '"url":"https://api.example.com/v1/status"',
      secret: "",
      expectChange: false,
    },
    {
      name: "http:// carve-out keeps diagnostic URLs (entropy rule reaches it)",
      input: "failed http://10-0-0-1x5f8k2m9p4q7r1s3t/x",
      secret: "",
      expectChange: false,
    },
    {
      name: "prose with a password word but no assignment is untouched",
      input: '"message":"I forgot my password today"',
      secret: "",
      expectChange: false,
    },
    {
      name: "long digit-only value is not secret-shaped",
      input: "count=123456789012345678901234",
      secret: "",
      expectChange: false,
    },
    {
      name: "long letters-only value is not secret-shaped",
      input: "title=abcdefghijabcdefghijab",
      secret: "",
      expectChange: false,
    },
    {
      name: "empty string stays empty",
      input: "",
      secret: "",
      expectChange: false,
    },
  ];
  for (const { name, input, secret, expectChange } of cases) {
    it(name, () => {
      const result = redact(input);
      if (expectChange) {
        expect(result).toContain("[REDACTED]");
        expect(result).not.toContain(secret);
      } else {
        expect(result).toBe(input);
      }
    });
  }

  it("is idempotent: redacting already-redacted output changes nothing", () => {
    const once = redact("password=hunter2hunter2 and Authorization: Bearer tok12345678");
    expect(redact(once)).toBe(once);
    expect(once).toContain("[REDACTED]");
  });

  it("never throws, even on non-string input", () => {
    expect(redact(undefined as unknown as string)).toBe("");
  });
});

describe("redactWorkflow", () => {
  it("drops credentials keys at every depth and keeps everything else intact", () => {
    const workflow = {
      name: "k",
      nodes: [
        {
          name: "HTTP",
          credentials: { httpBasicAuth: { user: "u", password: "p" } },
        },
      ],
      credentials: {},
      settings: { executionOrder: "v1" },
    };
    const snapshot = JSON.parse(JSON.stringify(workflow));
    const result = redactWorkflow(workflow) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(result.name).toBe("k");
    expect(result.settings).toEqual({ executionOrder: "v1" });
    const nodes = result.nodes as Array<Record<string, unknown>>;
    expect(nodes[0]?.name).toBe("HTTP");
    expect(Object.keys(nodes[0] as object)).toEqual(["name"]);
    // Input is never mutated.
    expect(workflow).toEqual(snapshot);
  });

  it("handles arrays, scalars, and null without throwing", () => {
    expect(redactWorkflow([1, "two", { credentials: { a: 1 }, keep: true }])).toEqual([
      1,
      "two",
      { keep: true },
    ]);
    expect(redactWorkflow(42)).toBe(42);
    expect(redactWorkflow("raw string")).toBe("raw string");
    expect(redactWorkflow(null)).toBeNull();
    expect(redactWorkflow(undefined)).toBeUndefined();
  });

  it("removes credentials inside deeply nested node parameters", () => {
    const workflow = {
      nodes: [{ parameters: { options: { credentials: { bearerAuth: { token: "t" } } } } }],
    };
    const result = redactWorkflow(workflow) as { nodes: Array<{ parameters: Record<string, unknown> }> };
    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(result.nodes[0]?.parameters).toEqual({ options: {} });
  });
});
