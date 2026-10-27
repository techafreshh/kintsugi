import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NebiusLLM } from "../src/llm/nebius.js";
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

describe("nebius tool-call verdict", () => {
  it("parses a submit_verdict tool call with rootCauseKind schema-drift", async () => {
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseToolCall(res, "submit_verdict", {
        rootCauseKind: "schema-drift",
        failureClass: "upstream schema change",
        affectedNodes: ["HttpRequest", "Set"],
        reasoning: "Upstream renamed a field.",
        confidence: 0.9,
      });
    });
    const llm = new NebiusLLM({
      NEBIUS_API_KEY: "test-key",
      NEBIUS_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(verdict.rootCauseKind).toBe("schema-drift");
    expect(validate(diagnoseVerdictSchema, verdict).ok).toBe(true);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("nebius text-JSON fallback", () => {
  it("parses plain-text JSON with no tool call and validates it", async () => {
    const body = JSON.stringify({
      rootCauseKind: "transient-429",
      failureClass: "transient upstream 429",
      affectedNodes: ["HttpRequest"],
      reasoning: "Upstream answered 429.",
      confidence: 0.8,
    });
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseText(res, body);
    });
    const llm = new NebiusLLM({
      NEBIUS_API_KEY: "test-key",
      NEBIUS_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(verdict.rootCauseKind).toBe("transient-429");
    expect(verdict.confidence).toBe(0.8);
    expect(validate(diagnoseVerdictSchema, verdict).ok).toBe(true);
  });
});

describe("nebius construction", () => {
  it("throws containing NEBIUS_API_KEY when the key is missing in live mode", () => {
    expect(() => new NebiusLLM({} as NodeJS.ProcessEnv)).toThrow(/NEBIUS_API_KEY/);
    expect(() => new NebiusLLM({ NEBIUS_API_KEY: "   " } as NodeJS.ProcessEnv)).toThrow(
      /NEBIUS_API_KEY/,
    );
  });

  it("createLLM returns live nebius when the key is set, mock otherwise", () => {
    expect(createLLM({} as NodeJS.ProcessEnv).mode).toBe("mock");
    const live = createLLM({
      NEBIUS_API_KEY: "test-key",
      NEBIUS_BASE_URL: "http://127.0.0.1:1/v1",
    } as NodeJS.ProcessEnv);
    expect(live.mode).toBe("live");
    expect(live.name).toBe("nebius");
  });
});

describe("nebius model routing", () => {
  it("sends MODEL_REASON as the request model for diagnose", async () => {
    stub.setHandler((req, res) => {
      const parsed = expectChatCompletions(req);
      expect(parsed["model"]).toBe("meta-llama/Llama-3-x");
      sseToolCall(res, "submit_verdict", {
        rootCauseKind: "schema-drift",
        failureClass: "x",
        affectedNodes: ["Set"],
        reasoning: "r",
        confidence: 0.9,
      });
    });
    const llm = new NebiusLLM({
      NEBIUS_API_KEY: "test-key",
      NEBIUS_BASE_URL: stub.baseUrl(),
      MODEL_REASON: "meta-llama/Llama-3-x",
    } as NodeJS.ProcessEnv);
    const verdict = await llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema);
    expect(verdict.rootCauseKind).toBe("schema-drift");
    expect(stub.requests).toHaveLength(1);
    expect((JSON.parse(stub.requests[0]?.body ?? "") as Record<string, unknown>)["model"]).toBe(
      "meta-llama/Llama-3-x",
    );
  });
});

describe("nebius retry", () => {
  it("throws after exactly 2 stub hits on double invalid JSON", async () => {
    stub.setHandler((req, res) => {
      expectChatCompletions(req);
      sseText(res, "not-json");
    });
    const llm = new NebiusLLM({
      NEBIUS_API_KEY: "test-key",
      NEBIUS_BASE_URL: stub.baseUrl(),
    } as NodeJS.ProcessEnv);
    await expect(llm.submit_verdict("diagnose", "prompt", diagnoseVerdictSchema)).rejects.toThrow();
    expect(stub.requests).toHaveLength(2);
  });
});
