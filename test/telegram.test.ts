import { describe, expect, it, afterEach } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import {
  answerCallbackQuery,
  handleTelegramUpdate,
  isTelegramEnabled,
  sendApprovalCard,
} from "../src/notify/telegram.js";
import { createApp } from "../src/receiver/app.js";
import { openStore, type Store } from "../src/store/store.js";
import { MockLLM } from "../src/llm/mock.js";
import { createOrchestrator } from "../src/orchestrator/orchestrator.js";
import type { Hono } from "hono";

const openStores: Store[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

function trackFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function enabledSettings(baseUrl = "https://tg.example") {
  return loadSettings({
    TELEGRAM_NOTIFIER_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-1",
    TELEGRAM_API_BASE_URL: baseUrl,
  });
}

function seedWorkflow() {
  return {
    id: "wf-1",
    name: "test-flow",
    nodes: [
      { name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
      { name: "HttpRequest", type: "n8n-nodes-base.httpRequest", typeVersion: 1, position: [200, 0], parameters: { url: "https://example.com/api" } },
      { name: "Set", type: "n8n-nodes-base.set", typeVersion: 1, position: [400, 0], parameters: { value: "={{ $json.old }}" } },
    ],
    connections: {},
  };
}

function seedPayload(workflowId: string) {
  return {
    workflowId,
    data: {
      resultData: {
        runData: {
          Start: [{ data: { main: [[{ json: { a: 1 } }]] } }],
          Set: [{ data: { main: [[{ json: { a: 1 } }]] }, error: { message: "boom" } }],
        },
      },
    },
  };
}

describe("telegram gate", () => {
  it("stays disabled without the flag even when credentials exist", () => {
    const settings = loadSettings({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" });
    expect(isTelegramEnabled(settings)).toBe(false);
    expect(settings.telegramEnabled).toBe(false);
  });

  it("gate off: sendApprovalCard touches fetch zero times", async () => {
    const { calls, fetchFn } = trackFetch();
    const settings = loadSettings({});
    const result = await sendApprovalCard(
      { eventId: "e-off", tier: "approve", diagnosisSummary: "summary" },
      settings,
      { fetchFn },
    );
    expect(result).toEqual({ sent: false });
    expect(calls).toHaveLength(0);
  });

  it("gate off: answerCallbackQuery touches fetch zero times", async () => {
    const { calls, fetchFn } = trackFetch();
    const result = await answerCallbackQuery("q-1", loadSettings({}), { fetchFn });
    expect(result).toEqual({ sent: false });
    expect(calls).toHaveLength(0);
  });
});

describe("sendApprovalCard", () => {
  it("posts sendMessage with the event id and exactly Approve/Reject buttons", async () => {
    const { calls, fetchFn } = trackFetch();
    const settings = enabledSettings("https://stub.test/");
    const result = await sendApprovalCard(
      { eventId: "evt-123", tier: "approve", diagnosisSummary: { rootCauseKind: "x" } },
      settings,
      { fetchFn },
    );
    expect(result).toEqual({ sent: true });
    const send = calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(send).toBeDefined();
    expect(send?.url).toBe("https://stub.test/botbot-token/sendMessage");
    const body = JSON.parse(String(send?.init.body)) as {
      chat_id: string;
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(body.chat_id).toBe("chat-1");
    expect(body.text).toContain("evt-123");
    expect(body.text).toContain("approve");
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.text)).toEqual(["Approve", "Reject"]);
    expect(buttons.map((button) => button.callback_data)).toEqual([
      "approve:evt-123",
      "reject:evt-123",
    ]);
  });
});

describe("handleTelegramUpdate", () => {
  it("approve tap calls sink.approve and answers the callback query", async () => {
    const { calls, fetchFn } = trackFetch();
    const seen: string[] = [];
    const result = await handleTelegramUpdate(
      { callback_query: { id: "q-9", data: "approve:evt-7" } },
      {
        approve: async (eventId: string) => void seen.push(eventId),
        reject: async () => void 0,
      },
      { settings: enabledSettings("https://stub.test"), fetchFn },
    );
    expect(result).toMatchObject({ handled: true, action: "approve", eventId: "evt-7" });
    expect(seen).toEqual(["evt-7"]);
    const answer = calls.find((call) => call.url.endsWith("/answerCallbackQuery"));
    expect(answer).toBeDefined();
    expect(JSON.parse(String(answer?.init.body))).toMatchObject({ callback_query_id: "q-9" });
  });

  it("reject tap calls sink.reject", async () => {
    const { calls, fetchFn } = trackFetch();
    const seen: string[] = [];
    const result = await handleTelegramUpdate(
      { callback_query: { id: "q-3", data: "reject:evt-8" } },
      {
        approve: async () => void 0,
        reject: async (eventId: string) => void seen.push(eventId),
      },
      { settings: enabledSettings("https://stub.test"), fetchFn },
    );
    expect(result).toMatchObject({ handled: true, action: "reject", eventId: "evt-8" });
    expect(seen).toEqual(["evt-8"]);
    expect(calls.some((call) => call.url.endsWith("/answerCallbackQuery"))).toBe(true);
  });

  it("unknown callback data makes no sink call and no fetch", async () => {
    const { calls, fetchFn } = trackFetch();
    let sinkCalls = 0;
    const result = await handleTelegramUpdate(
      { callback_query: { id: "q-1", data: "bogus:evt-1" } },
      {
        approve: async () => void sinkCalls++,
        reject: async () => void sinkCalls++,
      },
      { settings: enabledSettings("https://stub.test"), fetchFn },
    );
    expect(result).toEqual({ handled: false });
    expect(sinkCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("malformed updates resolve unhandled without throwing", async () => {
    const sink = {
      approve: async () => void 0,
      reject: async () => void 0,
    };
    for (const update of [null, undefined, {}, { callback_query: null }, { callback_query: {} }] as const) {
      await expect(handleTelegramUpdate(update, sink)).resolves.toEqual({ handled: false });
    }
  });
});

describe("orchestrator telegram wiring", () => {
  it("flag off: awaiting-approval performs zero fetches", async () => {
    const store = openStore(":memory:");
    openStores.push(store);
    const { calls, fetchFn } = trackFetch();
    const workflows = new Map<string, unknown>([["wf-1", seedWorkflow()]]);
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv);
    const orchestrator = createOrchestrator({
      store,
      llm,
      workflows,
      settings: loadSettings({}),
      fetchFn,
    });
    store.insertEvent({ executionId: "e-tg-off", payload: seedPayload("wf-1") });
    const result = await orchestrator.runRepairTurn("e-tg-off");
    expect(result.status).toBe("awaiting-approval");
    expect(calls).toHaveLength(0);
  });

  it("flag on: awaiting-approval sends a card carrying the event id", async () => {
    const store = openStore(":memory:");
    openStores.push(store);
    const { calls, fetchFn } = trackFetch();
    const workflows = new Map<string, unknown>([["wf-1", seedWorkflow()]]);
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "human-broke-it" } as NodeJS.ProcessEnv);
    const settings = enabledSettings("https://stub.test");
    const orchestrator = createOrchestrator({ store, llm, workflows, settings, fetchFn });
    store.insertEvent({ executionId: "e-tg-on", payload: seedPayload("wf-1") });
    const result = await orchestrator.runRepairTurn("e-tg-on");
    expect(result.status).toBe("awaiting-approval");
    const send = calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(send).toBeDefined();
    expect(String(send?.init.body)).toContain("e-tg-on");
  });
});

describe("POST /telegram/webhook", () => {
  function makeAppWithStub(env: Record<string, string>): { app: Hono; store: Store; calls: Array<{ url: string; init: RequestInit }> } {
    const settings = loadSettings({ ...process.env, ...env });
    const store = openStore(":memory:");
    openStores.push(store);
    const { calls, fetchFn } = trackFetch();
    return { app: createApp({ store, settings, fetchFn }), store, calls };
  }

  it("returns 400 on malformed JSON", async () => {
    const { app } = makeAppWithStub({});
    const res = await app.request("/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(res.status).toBe(400);
  });

  it("approve tap promotes the stored event and answers the callback", async () => {
    const { app, store, calls } = makeAppWithStub({
      TELEGRAM_NOTIFIER_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-1",
      TELEGRAM_API_BASE_URL: "https://stub.test",
    });
    store.insertEvent({ executionId: "e-webhook", payload: seedPayload("wf-1") });
    store.updateEventStatus("e-webhook", "awaiting-approval");
    const res = await app.request("/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query: { id: "q-web", data: "approve:e-webhook" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(store.getEvent("e-webhook")?.status).toBe("promoted");
    const answer = calls.find((call) => call.url.endsWith("/answerCallbackQuery"));
    expect(answer).toBeDefined();
    expect(String(answer?.init.body)).toContain("q-web");
  });

  it("unknown callback data still answers 200 without changing status", async () => {
    const { app, store } = makeAppWithStub({});
    store.insertEvent({ executionId: "e-unknown", payload: {} });
    const res = await app.request("/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query: { id: "q-u", data: "bogus:e-unknown" } }),
    });
    expect(res.status).toBe(200);
    expect(store.getEvent("e-unknown")?.status).toBe("received");
  });
});
