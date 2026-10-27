/**
 * Pinned contract (issue #10): `NebiusLLM` implements `LLMPort` on top of
 * `@earendil-works/pi-ai`'s OpenAI-compatible custom provider pointed at
 * Nebius. Stage routing is `diagnose`→`MODEL_REASON`, `patch`→`MODEL_FAST`,
 * `judge`→`MODEL_JUDGE` with blank-falls-through to the first non-blank of
 * the three and a hardcoded last resort. Each `submit_verdict` sends one
 * `models.complete()` call carrying a single `submit_verdict` tool whose
 * `parameters` is the caller's TypeBox schema verbatim, takes the tool-call
 * `arguments` (or a text-JSON fallback), validates via the shared `validate`
 * helper, retries the whole call at most once, and throws otherwise. The
 * pi-ai stack is loaded lazily so mock mode never touches it; the
 * constructor-injected key is passed as the per-request `apiKey` override so
 * tests never depend on ambient `process.env`. Caller prompts are forwarded
 * verbatim — no sanitization or prompt building here.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { validate } from "./schemas.js";
import type { LlmMode, LlmStage, LLMPort } from "./port.js";

/** Nebius OpenAI-compatible endpoint used when `NEBIUS_BASE_URL` is unset. */
const DEFAULT_BASE_URL = "https://api.studio.nebius.com/v1";

/** Last-resort model when all of `MODEL_FAST`/`MODEL_REASON`/`MODEL_JUDGE` are blank. */
const FALLBACK_MODEL = "meta-llama/Meta-Llama-3.1-70B-Instruct";

/**
 * Absent, empty, or whitespace-only values mean "unset" (mirrors
 * blank-falls-through in `loadSettings`); returns the trimmed value otherwise.
 */
function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describeErrors(errors: Array<{ path: string; message: string }>): string {
  const first = errors.slice(0, 3).map((error) => `${error.path}: ${error.message}`);
  return first.length > 0 ? first.join("; ") : "unknown validation error";
}

function describeFailure(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value;
}

/** Strip one enclosing markdown code fence (` ``` ` or ` ```json `) when present. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return trimmed;
  let inner = trimmed.slice(firstNewline + 1);
  const lastFence = inner.lastIndexOf("```");
  if (lastFence !== -1) inner = inner.slice(0, lastFence);
  return inner.trim();
}

function promptAsText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt === undefined) return "";
  try {
    const json = JSON.stringify(prompt);
    return json === undefined ? "" : json;
  } catch {
    return String(prompt);
  }
}

interface LoadedStack {
  // `any` keeps this module free of a static pi-ai import; the public
  // `submit_verdict` signature stays fully typed via TypeBox generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  complete: (modelId: string, context: any, options: any) => Promise<any>;
}

export class NebiusLLM implements LLMPort {
  readonly name = "nebius";
  readonly mode: LlmMode = "live";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelFast: string | undefined;
  private readonly modelReason: string | undefined;
  private readonly modelJudge: string | undefined;
  private stackPromise: Promise<LoadedStack> | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = optionalString(env.NEBIUS_API_KEY);
    if (apiKey === undefined) {
      throw new Error("nebius: NEBIUS_API_KEY is required for live mode");
    }
    this.apiKey = apiKey;
    this.baseUrl = optionalString(env.NEBIUS_BASE_URL) ?? DEFAULT_BASE_URL;
    this.modelFast = optionalString(env.MODEL_FAST);
    this.modelReason = optionalString(env.MODEL_REASON);
    this.modelJudge = optionalString(env.MODEL_JUDGE);
  }

  /** Stage→model map with blank-falls-through to the first non-blank model. */
  resolveModel(stage: LlmStage): string {
    const stageSpecific =
      stage === "diagnose" ? this.modelReason : stage === "patch" ? this.modelFast : this.modelJudge;
    if (stageSpecific !== undefined) return stageSpecific;
    return this.modelFast ?? this.modelReason ?? this.modelJudge ?? FALLBACK_MODEL;
  }

  async submit_verdict<T extends TSchema>(
    stage: LlmStage,
    prompt: unknown,
    schema: T,
  ): Promise<Static<T>> {
    const modelId = this.resolveModel(stage);
    let lastValidationSummary = "no usable verdict in response";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const candidate = await this.requestOnce(modelId, prompt, schema);
        if (candidate.ok) return candidate.value as Static<T>;
        lastValidationSummary = candidate.summary;
      } catch (cause) {
        lastValidationSummary = describeFailure(cause);
        // Transport (or pi-ai setup) failure: wrapped with `cause` below so
        // the raw error never leaks (mirrors `N8nClient.send`); the loop
        // retries once before the final throw.
        if (attempt === 1) {
          throw new Error(`nebius: stage "${stage}" request failed (${lastValidationSummary})`, {
            cause,
          });
        }
        continue;
      }
    }
    throw new Error(`nebius: stage "${stage}" verdict failed validation: ${lastValidationSummary}`);
  }

  private async requestOnce<T extends TSchema>(
    modelId: string,
    prompt: unknown,
    schema: T,
  ): Promise<{ ok: true; value: unknown } | { ok: false; summary: string }> {
    const stack = await this.ensureStack();
    let message: {
      content?: Array<{
        type?: string;
        text?: string;
        name?: string;
        arguments?: unknown;
        argumentsError?: string;
      }>;
    };
    try {
      message = await stack.complete(
        modelId,
        {
          messages: [{ role: "user", content: promptAsText(prompt), timestamp: Date.now() }],
          tools: [
            {
              name: "submit_verdict",
              description: "Return the verdict for this stage.",
              parameters: schema,
            },
          ],
        },
        { apiKey: this.apiKey },
      );
    } catch (cause) {
      throw new Error(`nebius: request failed (${describeFailure(cause)})`, { cause });
    }
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const toolBlock = blocks.find(
      (block) => block?.type === "toolCall" && block?.name === "submit_verdict",
    );
    if (toolBlock !== undefined) {
      if (typeof toolBlock.argumentsError === "string" && toolBlock.argumentsError !== "") {
        return { ok: false, summary: toolBlock.argumentsError };
      }
      const result = validate(schema, toolBlock.arguments);
      if (result.ok) return { ok: true, value: toolBlock.arguments };
      return { ok: false, summary: describeErrors(result.errors) };
    }
    const textBlock = blocks.find(
      (block) => block?.type === "text" && typeof block?.text === "string" && block.text.trim() !== "",
    );
    if (textBlock?.text !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(textBlock.text));
      } catch (cause) {
        return { ok: false, summary: describeFailure(cause) };
      }
      const result = validate(schema, parsed);
      if (result.ok) return { ok: true, value: parsed };
      return { ok: false, summary: describeErrors(result.errors) };
    }
    return { ok: false, summary: "no usable verdict in response" };
  }

  private ensureStack(): Promise<LoadedStack> {
    if (this.stackPromise === null) {
      this.stackPromise = this.loadStack();
    }
    return this.stackPromise;
  }

  private async loadStack(): Promise<LoadedStack> {
    const [{ createModels, createProvider, envApiKeyAuth }, { openAICompletionsApi }] =
      await Promise.all([
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-ai/api/openai-completions.lazy"),
      ]);
    const baseUrl = this.baseUrl.replace(/\/+$/, "");
    const distinctIds = [
      ...new Set(
        [this.modelFast, this.modelReason, this.modelJudge, FALLBACK_MODEL].filter(
          (id): id is string => id !== undefined,
        ),
      ),
    ];
    const models = distinctIds.map((id) => ({
      id,
      name: id,
      api: "openai-completions" as const,
      provider: "nebius" as const,
      baseUrl,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 131072,
      maxTokens: 8192,
    }));
    const provider = createProvider({
      id: "nebius",
      name: "Nebius",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("Nebius API key", ["NEBIUS_API_KEY"]) },
      models,
      api: openAICompletionsApi(),
    });
    const collection = createModels();
    collection.setProvider(provider);
    const byId = new Map(models.map((model) => [model.id, model]));
    return {
      complete: (modelId: string, context: unknown, options: unknown) => {
        const model = byId.get(modelId) ?? models[0];
        return collection.complete(model, context as never, options as never);
      },
    };
  }
}
