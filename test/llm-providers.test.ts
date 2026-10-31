import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "@sinclair/typebox";
import { OpenRouterLLM } from "../src/llm/openrouter.js";
import { DeepSeekLLM } from "../src/llm/deepseek.js";
import { createLLM } from "../src/llm/port.js";
import { diagnoseVerdictSchema, validate } from "../src/llm/schemas.js";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

type StubHandler = (req: RecordedRequest, res: ServerResponse) => void;

interface Stub {
  requests: RecordedRequest[];
  setHandler(handler: StubHandler): void;
  baseUrl(): string;
  close(): Promise<void>;
}

function startStub(): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  let handler: StubHandler = (_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "stub: no handler set" }));
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        requests,
        setHandler: (next) => {
          handler = next;
        },
        baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        close: () =>
          new Promise((resolveClose) => {
            server.closeIdleConnections();
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function sseToolCall(
  res: ServerResponse,
  toolName: string,
  args: unknown,
  id = "call_1",
): void {
  const chunk1 = JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            { index: 0, id, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  const chunk2 = JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${chunk1}\n\n`);
  res.write(`data: ${chunk2}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function sseText(res: ServerResponse, text: string): void {
  const chunk1 = JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  const chunk2 = JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${chunk1}\n\n`);
  res.write(`data: ${chunk2}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function expectChatCompletions(req: RecordedRequest): Record<string, unknown> {
  expect(req.method).toBe("POST");
  expect(req.url.endsWith("/chat/completions")).toBe(true);
  return JSON.parse(req.body) as Record<string, unknown>;
}

let stub: Stub;

beforeEach(async () => {
  stub = await startStub();
});

afterEach(async () => {
  await stub.close();
});

describe("openrouter tool-call verdict", () => {
  it("parses a submit_verdict tool call and reports mode openrouter", async () => {
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseToolCall(res, "submit_verdict", {
        rootCauseKind: "schema-drift",
        failureClass: "x",
        affectedNodes: ["HttpRequest", "Set"],
        reasoning: "Upstream renamed a field.",
        confidence: 0.9,
      });
    });
    const llm = new OpenRouterLLM({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("openrouter");
    expect(llm.name).toBe("openrouter");
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(verdict.failureClass).toBe("x");
    expect(validate(diagnoseVerdictSchema, verdict).ok).toBe(true);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("deepseek text-JSON fallback", () => {
  it("parses plain-text JSON with no tool call and reports mode deepseek", async () => {
    const gateSchema = Type.Object({ verdict: Type.String() }, { additionalProperties: false });
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseText(res, JSON.stringify({ verdict: "proceed" }));
    });
    const llm = new DeepSeekLLM({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("deepseek");
    expect(llm.name).toBe("deepseek");
    const verdict = await llm.submit_verdict("judge", "prompt", gateSchema);
    expect(verdict.verdict).toBe("proceed");
    expect(stub.requests).toHaveLength(1);
  });
});

describe("provider construction", () => {
  it("openrouter throws containing OPENROUTER_API_KEY when the key is missing or blank", () => {
    expect(() => new OpenRouterLLM({} as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/);
    expect(() => new OpenRouterLLM({ OPENROUTER_API_KEY: "   " } as NodeJS.ProcessEnv)).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("deepseek throws containing DEEPSEEK_API_KEY when the key is missing or blank", () => {
    expect(() => new DeepSeekLLM({} as NodeJS.ProcessEnv)).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => new DeepSeekLLM({ DEEPSEEK_API_KEY: "" } as NodeJS.ProcessEnv)).toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });
});

describe("provider model routing", () => {
  it("sends MODEL_REASON verbatim as the request model for diagnose (openrouter)", async () => {
    stub.setHandler((req, res) => {
      const parsed = expectChatCompletions(req);
      expect(parsed["model"]).toBe("openrouter/mistral-7b");
      sseToolCall(res, "submit_verdict", {
        rootCauseKind: "schema-drift",
        failureClass: "x",
        affectedNodes: ["Set"],
        reasoning: "r",
        confidence: 0.9,
      });
    });
    const llm = new OpenRouterLLM({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: stub.baseUrl(),
      MODEL_REASON: "openrouter/mistral-7b",
    } as NodeJS.ProcessEnv);
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(verdict.rootCauseKind).toBe("schema-drift");
    expect(stub.requests).toHaveLength(1);
    expect((JSON.parse(stub.requests[0]?.body ?? "") as Record<string, unknown>)["model"]).toBe(
      "openrouter/mistral-7b",
    );
  });

  it("sends MODEL_FAST verbatim as the request model for patch (deepseek)", async () => {
    const patchSchema = Type.Object(
      {
        ops: Type.Array(Type.Unknown()),
        rationale: Type.String(),
        confidence: Type.Number(),
      },
      { additionalProperties: false },
    );
    stub.setHandler((req, res) => {
      const parsed = expectChatCompletions(req);
      expect(parsed["model"]).toBe("deepseek-chat-fast");
      sseToolCall(res, "submit_verdict", { ops: [], rationale: "r", confidence: 0.9 });
    });
    const llm = new DeepSeekLLM({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: stub.baseUrl(),
      MODEL_FAST: "deepseek-chat-fast",
    } as NodeJS.ProcessEnv);
    const verdict = await llm.submit_verdict("patch", "prompt", patchSchema);
    expect(verdict.rationale).toBe("r");
    expect((JSON.parse(stub.requests[0]?.body ?? "") as Record<string, unknown>)["model"]).toBe(
      "deepseek-chat-fast",
    );
  });
});

describe("provider retry", () => {
  it("throws after exactly 2 stub hits on double invalid JSON (openrouter)", async () => {
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseText(res, "not-json");
    });
    const llm = new OpenRouterLLM({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    await expect(llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow();
    expect(stub.requests).toHaveLength(2);
  });

  it("throws after exactly 2 stub hits on double invalid JSON (deepseek)", async () => {
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseText(res, "not-json");
    });
    const llm = new DeepSeekLLM({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    await expect(llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow();
    expect(stub.requests).toHaveLength(2);
  });
});

describe("createLLM switch", () => {
  it("returns mock for KINTSUGI_MOCK_LLM=1 even when a provider is configured", () => {
    const llm = createLLM({
      KINTSUGI_MOCK_LLM: "1",
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("mock");
    expect(llm.name).toBe("mock");
  });

  it("returns openrouter when LLM_PROVIDER=openrouter and its key is set", () => {
    const llm = createLLM({
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "k",
      OPENROUTER_BASE_URL: "http://127.0.0.1:1/v1",
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("openrouter");
    expect(llm.name).toBe("openrouter");
  });

  it("returns deepseek when LLM_PROVIDER=deepseek and its key is set", () => {
    const llm = createLLM({
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "k",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:1/v1",
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("deepseek");
    expect(llm.name).toBe("deepseek");
  });

  it("trims and lowercases LLM_PROVIDER", () => {
    const llm = createLLM({
      LLM_PROVIDER: "  DeepSeek  ",
      DEEPSEEK_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("deepseek");
  });

  it("returns off when LLM_PROVIDER is unset", () => {
    const llm = createLLM({} as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("off");
    expect(llm.name).toBe("off");
  });

  it("returns off when the named provider key is missing, with zero outbound calls", async () => {
    const llm = createLLM({
      LLM_PROVIDER: "openrouter",
      OPENROUTER_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("off");
    expect(stub.requests).toHaveLength(0);
    await expect(llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow(
      /llm off/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it("returns off for an unknown LLM_PROVIDER with zero outbound calls", async () => {
    const llm = createLLM({ LLM_PROVIDER: "nebula" } as NodeJS.ProcessEnv);
    expect(llm.mode).toBe("off");
    await expect(llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow(
      /llm off/,
    );
    expect(stub.requests).toHaveLength(0);
  });
});
