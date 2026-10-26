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
  nebiusApiKey: string | undefined;
  nebiusBaseUrl: string | undefined;
  modelFast: string | undefined;
  modelReason: string | undefined;
  modelJudge: string | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
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
 * Parsed once at startup by each module's wiring point — not a module-level
 * singleton, so env changes between tests never leak across imports.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    port: resolvePort(env),
    dashboardToken: optionalString(env.DASHBOARD_TOKEN),
    nebiusApiKey: optionalString(env.NEBIUS_API_KEY),
    nebiusBaseUrl: optionalString(env.NEBIUS_BASE_URL),
    modelFast: optionalString(env.MODEL_FAST),
    modelReason: optionalString(env.MODEL_REASON),
    modelJudge: optionalString(env.MODEL_JUDGE),
    telegramBotToken: optionalString(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: optionalString(env.TELEGRAM_CHAT_ID),
  };
}
