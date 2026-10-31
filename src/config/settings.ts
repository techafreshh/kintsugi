/**
 * Typed, parsed-once configuration. `loadSettings()` reads the process env a
 * single time into a `Settings` object so no other module ever touches
 * `process.env` directly. It never throws: missing variables yield
 * `undefined`, leaving presence checks to the consumer modules (store, LLM
 * provider, notifier) that wire the feature each variable enables.
 */
export interface Settings {
  port: number;
  dashboardToken: string | undefined;
  llmProvider: string | undefined;
  openrouterApiKey: string | undefined;
  openrouterBaseUrl: string | undefined;
  deepseekApiKey: string | undefined;
  deepseekBaseUrl: string | undefined;
  modelFast: string | undefined;
  modelReason: string | undefined;
  modelJudge: string | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  /** Opt-in Telegram approval cards; only the exact value `true` (trimmed, case-insensitive) enables sends. Default off. */
  telegramEnabled: boolean;
  /** Override of the Telegram Bot API base URL; blank means the built-in default. */
  telegramApiBaseUrl: string | undefined;
  /** SQLite database file path; unset means the consumer wiring applies its default (kintsugi.db). */
  dbPath: string | undefined;
  /** n8n instance root (base URL the n8n client appends `/api/v1` to); unset disables n8n-backed flows. */
  n8nBaseUrl: string | undefined;
  /** n8n API key sent as `X-N8N-API-KEY` on every client request; must accompany n8nBaseUrl. */
  n8nApiKey: string | undefined;
  /** Mock-upstream base URL driving the demo workflow HTTP node (`<base>/api/users`); blank falls back to the seeder default. */
  mockUpstreamUrl: string | undefined;
  /** Public Kintsugi root used to build the error-trigger `/error-hook` target; blank falls back to localhost:port. */
  publicUrl: string | undefined;
}

/**
 * Port binding precedence per the machine contract: PORT, then KINTSUGI_PORT,
 * then 8080. Blank or non-integer/out-of-range values fall through to the
 * next source instead of crashing startup.
 */
export function resolvePort(
  env: Partial<Record<"PORT" | "KINTSUGI_PORT", string | undefined>> = process.env,
): number {
  for (const value of [env.PORT, env.KINTSUGI_PORT]) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const port = Number(trimmed);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return 8080;
}

/**
 * Absent, empty, or whitespace-only env values all mean "unset" (mirrors
 * blank-falls-through in resolvePort); presence is validated by consumers.
 */
function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}

/**
 * Opt-in flag for Telegram approval cards: only the exact value `true`
 * (trimmed, case-insensitive) enables sends; `1`/`yes`/blank/unset all mean
 * off. Never throws.
 */
function isTelegramEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.trim().toLowerCase() === "true";
}

/**
 * Parsed once at startup by each module's wiring point — not a module-level
 * singleton, so env changes between tests never leak across imports.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    port: resolvePort(env),
    dashboardToken: optionalString(env.DASHBOARD_TOKEN),
    llmProvider: optionalString(env.LLM_PROVIDER),
    openrouterApiKey: optionalString(env.OPENROUTER_API_KEY),
    openrouterBaseUrl: optionalString(env.OPENROUTER_BASE_URL),
    deepseekApiKey: optionalString(env.DEEPSEEK_API_KEY),
    deepseekBaseUrl: optionalString(env.DEEPSEEK_BASE_URL),
    modelFast: optionalString(env.MODEL_FAST),
    modelReason: optionalString(env.MODEL_REASON),
    modelJudge: optionalString(env.MODEL_JUDGE),
    telegramBotToken: optionalString(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: optionalString(env.TELEGRAM_CHAT_ID),
    telegramEnabled: isTelegramEnabledFlag(env.TELEGRAM_NOTIFIER_ENABLED),
    telegramApiBaseUrl: optionalString(env.TELEGRAM_API_BASE_URL),
    dbPath: optionalString(env.KINTSUGI_DB_PATH),
    n8nBaseUrl: optionalString(env.N8N_BASE_URL),
    n8nApiKey: optionalString(env.N8N_API_KEY),
    mockUpstreamUrl: optionalString(env.MOCK_UPSTREAM_URL),
    publicUrl: optionalString(env.KINTSUGI_PUBLIC_URL),
  };
}
