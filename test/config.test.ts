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
      nebiusApiKey: undefined,
      nebiusBaseUrl: undefined,
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
    });
  });

  it("maps every environment variable to its Settings field", () => {
    const env = {
      PORT: "9911",
      DASHBOARD_TOKEN: "dash-tok",
      NEBIUS_API_KEY: "nebius-key",
      NEBIUS_BASE_URL: "https://api.nebius.example/v1",
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
    };
    expect(loadSettings(env)).toEqual({
      port: 9911,
      dashboardToken: "dash-tok",
      nebiusApiKey: "nebius-key",
      nebiusBaseUrl: "https://api.nebius.example/v1",
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
    });
  });

  it("treats blank and whitespace-only values as unset", () => {
    const settings = loadSettings({
      DASHBOARD_TOKEN: "  ",
      NEBIUS_API_KEY: "",
      MODEL_FAST: "\t ",
      TELEGRAM_BOT_TOKEN: " ",
      TELEGRAM_CHAT_ID: "",
      TELEGRAM_API_BASE_URL: "  ",
      KINTSUGI_DB_PATH: " ",
      N8N_BASE_URL: "\n ",
      N8N_API_KEY: " ",
    });
    expect(settings.dashboardToken).toBeUndefined();
    expect(settings.nebiusApiKey).toBeUndefined();
    expect(settings.modelFast).toBeUndefined();
    expect(settings.telegramBotToken).toBeUndefined();
    expect(settings.telegramChatId).toBeUndefined();
    expect(settings.telegramApiBaseUrl).toBeUndefined();
    expect(settings.dbPath).toBeUndefined();
    expect(settings.n8nBaseUrl).toBeUndefined();
    expect(settings.n8nApiKey).toBeUndefined();
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
