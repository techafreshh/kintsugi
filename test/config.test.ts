import { describe, expect, it } from "vitest";
import { loadSettings, resolvePort } from "../src/config/settings.js";

describe("loadSettings", () => {
  it("maps PORT=9911 to port 9911", () => {
    expect(loadSettings({ PORT: "9911" }).port).toBe(9911);
  });

  it("with no env: port 8080 and every optional variable undefined, never throws", () => {
    expect(loadSettings({})).toEqual({
      port: 8080,
      dashboardToken: undefined,
      llmProvider: undefined,
      openrouterApiKey: undefined,
      openrouterBaseUrl: undefined,
      deepseekApiKey: undefined,
      deepseekBaseUrl: undefined,
      modelFast: undefined,
      modelReason: undefined,
      modelJudge: undefined,
      telegramBotToken: undefined,
      telegramChatId: undefined,
      telegramEnabled: false,
      telegramApiBaseUrl: undefined,
      dbPath: undefined,
      n8nBaseUrl: undefined,
      n8nApiKey: undefined,
      tinyfishApiKey: undefined,
      tinyfishApiBaseUrl: undefined,
      mockUpstreamUrl: undefined,
      publicUrl: undefined,
    });
  });

  it("maps every environment variable to its Settings field", () => {
    const env = {
      PORT: "9911",
      DASHBOARD_TOKEN: "dash-tok",
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.example/v1",
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
      MODEL_FAST: "fast-model",
      MODEL_REASON: "reason-model",
      MODEL_JUDGE: "judge-model",
      TELEGRAM_BOT_TOKEN: "tg-bot",
      TELEGRAM_CHAT_ID: "42",
      TELEGRAM_NOTIFIER_ENABLED: "true",
      TELEGRAM_API_BASE_URL: "https://tg.example", 
      KINTSUGI_DB_PATH: "data/kintsugi.db",
      N8N_BASE_URL: "https://n8n.example",
      N8N_API_KEY: "n8n-key",
      TINYFISH_API_KEY: "tinyfish-key",
      TINYFISH_API_BASE_URL: "https://search.example",
      MOCK_UPSTREAM_URL: "http://chaos.example:3001",
      KINTSUGI_PUBLIC_URL: "https://kintsugi.example",
    };
    expect(loadSettings(env)).toEqual({
      port: 9911,
      dashboardToken: "dash-tok",
      llmProvider: "openrouter",
      openrouterApiKey: "openrouter-key",
      openrouterBaseUrl: "https://openrouter.example/v1",
      deepseekApiKey: "deepseek-key",
      deepseekBaseUrl: "https://deepseek.example/v1",
      modelFast: "fast-model",
      modelReason: "reason-model",
      modelJudge: "judge-model",
      telegramBotToken: "tg-bot",
      telegramChatId: "42",
      telegramEnabled: true,
      telegramApiBaseUrl: "https://tg.example",
      dbPath: "data/kintsugi.db",
      n8nBaseUrl: "https://n8n.example",
      n8nApiKey: "n8n-key",
      tinyfishApiKey: "tinyfish-key",
      tinyfishApiBaseUrl: "https://search.example",
      mockUpstreamUrl: "http://chaos.example:3001",
      publicUrl: "https://kintsugi.example",
    });
  });

  it("treats blank and whitespace-only values as unset", () => {
    const settings = loadSettings({
      DASHBOARD_TOKEN: "  ",
      LLM_PROVIDER: "  ",
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: " ",
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "  ",
      MODEL_FAST: "\t ",
      TELEGRAM_BOT_TOKEN: " ",
      TELEGRAM_CHAT_ID: "",
      TELEGRAM_API_BASE_URL: "  ",
      KINTSUGI_DB_PATH: " ",
      N8N_BASE_URL: "\n ",
      N8N_API_KEY: " ",
      TINYFISH_API_KEY: "  ",
      TINYFISH_API_BASE_URL: " ",
      MOCK_UPSTREAM_URL: "  ",
      KINTSUGI_PUBLIC_URL: "",
    });
    expect(settings.dashboardToken).toBeUndefined();
    expect(settings.llmProvider).toBeUndefined();
    expect(settings.openrouterApiKey).toBeUndefined();
    expect(settings.openrouterBaseUrl).toBeUndefined();
    expect(settings.deepseekApiKey).toBeUndefined();
    expect(settings.deepseekBaseUrl).toBeUndefined();
    expect(settings.modelFast).toBeUndefined();
    expect(settings.telegramBotToken).toBeUndefined();
    expect(settings.telegramChatId).toBeUndefined();
    expect(settings.telegramApiBaseUrl).toBeUndefined();
    expect(settings.dbPath).toBeUndefined();
    expect(settings.n8nBaseUrl).toBeUndefined();
    expect(settings.n8nApiKey).toBeUndefined();
    expect(settings.tinyfishApiKey).toBeUndefined();
    expect(settings.tinyfishApiBaseUrl).toBeUndefined();
    expect(settings.mockUpstreamUrl).toBeUndefined();
    expect(settings.publicUrl).toBeUndefined();
  });

  it("enables Telegram only on exact case-insensitive true; default off", () => {
    expect(loadSettings({}).telegramEnabled).toBe(false);
    expect(loadSettings({ TELEGRAM_NOTIFIER_ENABLED: "true" }).telegramEnabled).toBe(true);
    expect(loadSettings({ TELEGRAM_NOTIFIER_ENABLED: " TRUE " }).telegramEnabled).toBe(true);
    expect(loadSettings({ TELEGRAM_NOTIFIER_ENABLED: "True" }).telegramEnabled).toBe(true);
    for (const off of ["1", "yes", "on", "enabled", "", "  ", "false", "tru"] as const) {
      expect(loadSettings({ TELEGRAM_NOTIFIER_ENABLED: off }).telegramEnabled).toBe(false);
    }
  });
});

describe("resolvePort", () => {
  const cases: Array<{
    name: string;
    env: Partial<Record<"PORT" | "KINTSUGI_PORT", string | undefined>>;
    expected: number;
  }> = [
    { name: "no env -> 8080", env: {}, expected: 8080 },
    { name: "PORT wins", env: { PORT: "9911" }, expected: 9911 },
    { name: "KINTSUGI_PORT alone is honored", env: { KINTSUGI_PORT: "9922" }, expected: 9922 },
    { name: "both set -> PORT wins", env: { PORT: "9911", KINTSUGI_PORT: "9922" }, expected: 9911 },
    { name: "invalid PORT falls through to KINTSUGI_PORT", env: { PORT: "not-a-port", KINTSUGI_PORT: "9922" }, expected: 9922 },
    { name: "blank PORT falls through to default", env: { PORT: "  " }, expected: 8080 },
    { name: "out-of-range PORT falls through", env: { PORT: "70000", KINTSUGI_PORT: "9922" }, expected: 9922 },
  ];
  for (const { name, env, expected } of cases) {
    it(name, () => {
      expect(resolvePort(env)).toBe(expected);
    });
  }
});
