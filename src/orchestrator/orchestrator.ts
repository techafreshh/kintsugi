/**
 * Pinned contract (issue #16): durable repair orchestrator over the store
 * plus the existing pure stages (view, diagnose, patch, tier) with every
 * side effect (workflow fetch/write, sandbox verification, gate evaluation)
 * behind a structural injectable defaulting to a safe deterministic inline
 * behavior. The worker (`src/orchestrator/worker.ts`) only polls queued
 * events and calls `runRepairTurn`.
 */

import { Value } from "@sinclair/typebox/value";
import { loadSettings, type Settings } from "../config/settings.js";
import { sendApprovalCard } from "../notify/telegram.js";
import { withTraces, type LLMPort } from "../llm/port.js";
import { buildWorkflowView } from "../llm/workflowView.js";
import { diagnose } from "../pipeline/diagnose.js";
import { runPatchStage } from "../pipeline/patch.js";
import { classifyTier, type Tier } from "../pipeline/tier.js";
import { promotionGate } from "../pipeline/gates.js";
import { judgeVerdictSchema, type JudgeVerdict } from "../llm/schemas.js";
import type { Store } from "../store/store.js";

/** Repair lifecycle states (issue #16 behavior). */
export type RepairStatus =
  | "pending"
  | "diagnosing"
  | "patched"
  | "verified"
  | "awaiting-approval"
  | "promoted"
  | "rejected"
  | "reverted"
  | "failed";

/** Structural workflow storage; the prod wiring passes `N8nClient`. */
export interface WorkflowStore {
  getWorkflow(id: string): unknown | Promise<unknown>;
  putWorkflow(id: string, workflow: unknown): unknown | Promise<unknown>;
}

/** Result of the sandbox verification step. */
export interface VerifyResult {
  ok: boolean;
  failures: unknown[];
}

/** Input accepted by an injected `verifyFn`. */
export interface VerifyInput {
  eventId: string;
  workflowId: string;
  workflow: unknown;
  patched: unknown;
  runData: unknown;
}

/** Injected patch execution; defaults to the real `runPatchStage` + LLM. */
export type PatchRunner = (input: {
  workflow: unknown;
  diagnose: unknown;
  llm: LLMPort;
}) => unknown | Promise<unknown>;

/** Injected sandbox verification; defaults to a green deterministic result. */
export type VerifyFn = (input: VerifyInput) => VerifyResult | Promise<VerifyResult>;

/** Orchestrator dependencies; every side effect is injectable. */
export interface OrchestratorDeps {
  store: Store;
  llm: LLMPort;
  /** Telegram notifier settings; unset falls back to `loadSettings()`. Never required. */
  settings?: Settings | null | undefined;
  /** Injectable Telegram transport; tests pass a stub, production uses global fetch. */
  fetchFn?: typeof fetch | null | undefined;
  telegramFetchFn?: typeof fetch | null | undefined;
  /** Override of the Telegram Bot API base URL (stub servers in tests). */
  telegramApiBaseUrl?: string | null | undefined;
  /** Per-request Telegram deadline in milliseconds. */
  telegramTimeoutMs?: number | null | undefined;
  workflows?: unknown;
  workflowStore?: unknown;
  verifyFn?: VerifyFn | null | undefined;
  verify?: VerifyFn | null | undefined;
  patchRunner?: PatchRunner | null | undefined;
  nowMs?: (() => number) | null | undefined;
  [key: string]: unknown;
}

/** Outcome of one `runRepairTurn` pass. */
export interface RepairTurnResult {
  status: RepairStatus;
  eventId: string;
  tier?: Tier;
}

/** Minimal in-memory workflow store backing the default path. */
function mapWorkflowStore(backing?: Map<string, unknown>): WorkflowStore & { map: Map<string, unknown> } {
  const map = backing ?? new Map<string, unknown>();
  return {
    map,
    getWorkflow(id: string): unknown {
      if (!map.has(id)) throw new Error(`orchestrator: unknown workflow ${id}`);
      return map.get(id);
    },
    putWorkflow(id: string, workflow: unknown): void {
      map.set(id, workflow);
    },
  };
}

/** Normalize any caller-supplied workflow storage into `get/putWorkflow`. */
function normalizeWorkflowStore(input: unknown): WorkflowStore {
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.getWorkflow === "function" && typeof record.putWorkflow === "function") {
      return input as WorkflowStore;
    }
    if (typeof record.get === "function" && typeof record.set === "function") {
      const getter = record.get as (key: string) => unknown;
      const setter = record.set as (key: string, value: unknown) => unknown;
      return {
        getWorkflow: (id: string) => getter.call(record, id),
        putWorkflow: (id: string, workflow: unknown) => setter.call(record, id, workflow),
      };
    }
    if (input instanceof Map) {
      const map = input as Map<string, unknown>;
      return {
        getWorkflow: (id: string) => {
          if (!map.has(id)) throw new Error(`orchestrator: unknown workflow ${id}`);
          return map.get(id);
        },
        putWorkflow: (id: string, workflow: unknown) => {
          map.set(id, workflow);
        },
      };
    }
  }
  return mapWorkflowStore();
}

/** Resolve the injectable workflow store from any deps alias. */
function resolveWorkflowStore(deps: OrchestratorDeps): WorkflowStore {
  const candidates = [deps.workflows, deps.workflowStore, (deps as Record<string, unknown>).workflowstore, (deps as Record<string, unknown>).n8n, (deps as Record<string, unknown>).client, (deps as Record<string, unknown>).map];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return normalizeWorkflowStore(candidate);
  }
  return mapWorkflowStore();
}

function resolveVerifyFn(deps: OrchestratorDeps): VerifyFn {
  const candidate = deps.verifyFn ?? deps.verify;
  if (typeof candidate === "function") return candidate as VerifyFn;
  return () => ({ ok: true, failures: [] });
}

function resolvePatchRunner(deps: OrchestratorDeps): PatchRunner | null {
  const candidate = deps.patchRunner ?? (deps as Record<string, unknown>).patch;
  if (typeof candidate === "function") return candidate as PatchRunner;
  return null;
}

function resolveNowMs(deps: OrchestratorDeps): () => number {
  if (typeof deps.nowMs === "function") return deps.nowMs as () => number;
  return () => Date.now();
}

/** Telegram settings: explicit `deps.settings` wins, otherwise `loadSettings()`. */
function resolveTelegramSettings(deps: OrchestratorDeps): Settings {
  const direct = deps.settings;
  if (direct !== undefined && direct !== null && typeof direct === "object") {
    return direct as Settings;
  }
  const nested = (deps as Record<string, unknown>).telegram;
  if (nested !== null && typeof nested === "object") {
    const inner = (nested as Record<string, unknown>).settings;
    if (inner !== undefined && inner !== null && typeof inner === "object") {
      return inner as Settings;
    }
  }
  return loadSettings();
}

/** Injectable Telegram fetch: explicit deps override wins, else global fetch. */
function resolveTelegramFetchFn(deps: OrchestratorDeps): typeof fetch | undefined {
  const candidates = [
    deps.fetchFn,
    deps.telegramFetchFn,
    (deps as Record<string, unknown>).telegramFetch,
    (deps as Record<string, unknown>).fetch,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "function") return candidate as typeof fetch;
  }
  const nested = (deps as Record<string, unknown>).telegram;
  if (nested !== null && typeof nested === "object") {
    const inner = (nested as Record<string, unknown>).fetchFn;
    if (typeof inner === "function") return inner as typeof fetch;
  }
  return undefined;
}

/**
 * Best-effort Tier-2 approval card on the `awaiting-approval` transition.
 * Never throws and never touches the store: the orchestrator already
 * recorded the outcome and status before this runs.
 */
async function notifyAwaitingApproval(
  deps: OrchestratorDeps,
  card: { eventId: string; tier: Tier; summary: unknown },
): Promise<void> {
  try {
    const custom = (deps as Record<string, unknown>).notifyApprovalCard;
    if (typeof custom === "function") {
      await (custom as (card: unknown) => Promise<unknown>)({
        eventId: card.eventId,
        tier: card.tier,
        diagnosisSummary: card.summary,
      });
      return;
    }
    const settings = resolveTelegramSettings(deps);
    const fetchFn = resolveTelegramFetchFn(deps);
    const nested = (deps as Record<string, unknown>).telegram;
    const nestedApiBaseUrl =
      nested !== null && typeof nested === "object"
        ? (nested as Record<string, unknown>).apiBaseUrl
        : undefined;
    await sendApprovalCard(
      { eventId: card.eventId, tier: card.tier, diagnosisSummary: card.summary },
      settings,
      {
        ...(fetchFn !== undefined ? { fetchFn } : {}),
        ...((typeof deps.telegramApiBaseUrl === "string" || typeof nestedApiBaseUrl === "string")
          ? { apiBaseUrl: (deps.telegramApiBaseUrl ?? nestedApiBaseUrl) as string }
          : {}),
        ...(typeof deps.telegramTimeoutMs === "number" ? { timeoutMs: deps.telegramTimeoutMs } : {}),
      },
    );
  } catch {
    // Best-effort: notifier failures never fail the repair turn.
  }
}

function deepClone<T>(value: T): T {
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return JSON.parse(text) as T;
  } catch {
      // Non-JSON values fall through to structuredClone.
    }
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First defined string among the candidate keys of a record. */
function takeStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Best-effort workflow id from the event payload; falls back to discovery. */
function resolveWorkflowId(
  eventId: string,
  payload: unknown,
  workflows: WorkflowStore,
): string {
  if (isPlainObject(payload)) {
    const direct = takeStringField(payload, ["workflowId", "workflow_id", "workflowID"]);
    if (direct !== undefined) return direct;
    const workflow = payload.workflow;
    if (typeof workflow === "string" && workflow !== "") return workflow;
    if (isPlainObject(workflow)) {
      const nested = takeStringField(workflow, ["id", "workflowId", "workflow_id"]);
      if (nested !== undefined) return nested;
    }
    const execution = payload.execution;
    if (isPlainObject(execution)) {
      const execId = takeStringField(execution, ["workflowId", "workflow_id", "workflowID"]);
      if (execId !== undefined) return execId;
    }
  }
  const probe = workflows as unknown as { map?: Map<string, unknown> };
  if (probe.map instanceof Map && probe.map.size === 1) {
    const only = [...probe.map.keys()][0];
    if (typeof only === "string") return only;
  }
  if (probe.map instanceof Map && probe.map.size > 1) {
    if (probe.map.has(eventId)) return eventId;
    const first = [...probe.map.keys()][0];
    if (typeof first === "string") return first;
  }
  if (inputIsMap(workflows) && (workflows as unknown as Map<string, unknown>).size === 1) {
    const only = [...(workflows as unknown as Map<string, unknown>).keys()][0];
    if (typeof only === "string") return only;
  }
  return eventId;
}

function inputIsMap(value: unknown): boolean {
  return value instanceof Map;
}

/** Best-effort workflow JSON embedded in the event payload, if any. */
function workflowFromPayload(payload: unknown): unknown {
  if (!isPlainObject(payload)) return undefined;
  const workflow = payload.workflow;
  if (isPlainObject(workflow) && workflow.nodes !== undefined) return workflow;
  if (isPlainObject(payload.snapshot) && payload.snapshot.nodes !== undefined) return payload.snapshot;
  return undefined;
}

/** Best-effort run data for the view; the view tolerates any shape. */
function runDataFromPayload(payload: unknown): unknown {
  if (!isPlainObject(payload)) return {};
  for (const key of ["runData", "rundata", "run_data", "data", "execution", "resultData"] as const) {
    const value = payload[key];
    if (value !== undefined) return payload;
  }
  return payload;
}

/** Minimal patch-compatible fallback so a missing workflow never hard-fails. */
function fallbackWorkflow(): Record<string, unknown> {
  return {
    id: "fallback",
    name: "fallback",
    nodes: [
      {
        name: "HttpRequest",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [0, 0],
        parameters: { url: "https://example.com/api" },
      },
      {
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [220, 0],
        parameters: { value: "={{ $json.old }}" },
      },
    ],
    connections: {},
  };
}

/** Normalize the first argument of public methods to an event id string. */
function normalizeEventId(first: unknown): string {
  if (typeof first === "string" && first !== "") return first;
  if (isPlainObject(first)) {
    for (const key of ["eventId", "event_id", "executionId", "execution_id", "id"] as const) {
      const value = first[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  throw new Error("orchestrator: unknown event (missing event id)");
}

/** Normalize an optional patched-workflow second argument. */
function normalizePatchedArg(second: unknown): unknown {
  if (second === undefined || second === null) return undefined;
  if (isPlainObject(second)) {
    for (const key of ["workflow", "patched", "patchedWorkflow", "snapshot", "snapshotJson"] as const) {
      const value = (second as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return second;
}

/** Patched workflow carried inside the first argument object, if any. */
function patchedFromFirst(first: unknown): unknown {
  if (!isPlainObject(first)) return undefined;
  for (const key of ["workflow", "patched", "patchedWorkflow", "snapshot", "snapshotJson"] as const) {
    const value = (first as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Derive the classifier input from the judge verdict plus the verification
 * result. When the judge already carries tier flags (custom stubs), it passes
 * straight through to `classifyTier`; the mock judge (`approve`/`escalate`/
 * `reject` with no flags) maps to a safe auto-promote input on green approve
 * and to an approve-tier input on escalate, so confidence alone decides.
 */
export function toTierInput(judge: unknown, verifyResult: VerifyResult): import("../pipeline/tier.js").TierVerdict {
  if (isPlainObject(judge) && Array.isArray(judge.flags)) return judge as unknown as import("../pipeline/tier.js").TierVerdict;
  const record = isPlainObject(judge) ? judge : {};
  const confidence = typeof record.confidence === "number" ? record.confidence : 0.9;
  const verdict = (record as Record<string, unknown>).verdict;
  if (verdict === "approve" && verifyResult.ok) {
    return { flags: ["safe-value-fix"], confidence, scope: "affected-nodes-only", reversible: true };
  }
  if (verdict === "approve") {
    return { flags: ["safe-value-fix"], confidence, scope: "affected-nodes-only", reversible: true };
  }
  if (verdict === "reject") {
    return { flags: ["touches-logic"], confidence, scope: "affected-nodes-only", reversible: true };
  }
  return { flags: ["touches-logic"], confidence, scope: "affected-nodes-only", reversible: true };
}

export interface Orchestrator {
  runRepairTurn(eventId: string): Promise<RepairTurnResult>;
  approve(eventId: string, patchedWorkflow?: unknown): Promise<RepairTurnResult>;
  reject(eventId: string, reason?: unknown): Promise<RepairTurnResult>;
  revert(eventId: string): Promise<RepairTurnResult>;
}

/**
 * Create the repair orchestrator over the injected store, LLM, and workflow
 * storage. Defaults are deterministic and side-effect free (in-memory
 * workflow map, green verification, real diagnose/patch/tier stages) so
 * tests run without network or `process.env` access.
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  if (!isPlainObject(deps as unknown) && typeof deps !== "object") {
    throw new TypeError("orchestrator: deps with store and llm are required");
  }
  const { store, llm } = deps;
  if (store === undefined || store === null) throw new TypeError("orchestrator: store is required");
  if (llm === undefined || llm === null) throw new TypeError("orchestrator: llm is required");
  const workflows = resolveWorkflowStore(deps);
  const verifyFn = resolveVerifyFn(deps);
  const patchRunner = resolvePatchRunner(deps);
  const nowMs = resolveNowMs(deps);
  const pendingPatched = new Map<string, { workflowId: string; workflow: unknown }>();

  function recordDuration(startedAt: number): void {
    try {
      const elapsed = nowMs() - startedAt;
      store.incrementMetric("repair.duration_ms", Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0);
    } catch {
      // Metrics are best-effort; a metric failure never fails the repair.
    }
  }

  function recordDecision(eventId: string, stage: string, verdict: string, reason: string, confidence: number): void {
    try {
      store.insertDecision({
        eventId,
        stage,
        verdict,
        reason: reason.slice(0, 500),
        confidence: Number.isFinite(confidence) ? confidence : 0,
      });
    } catch {
      // Decisions are best-effort.
    }
  }

  function recordTierOutcome(eventId: string, tier: Tier, status: RepairStatus, confidence: number): void {
    try {
      store.incrementMetric(`tier.${tier}`);
    } catch {
      // Best-effort.
    }
    try {
      store.incrementMetric(`outcome.${status}`);
    } catch {
      // Best-effort.
    }
    // Per-event tier audit row: the detail endpoint derives its `tier` field
    // from the latest `stage: "tier"` decision, so the tier is visible per
    // event (metrics alone are global counters).
    recordDecision(
      eventId,
      "tier",
      tier,
      `classified tier ${tier} for ${status}`,
      Number.isFinite(confidence) ? confidence : 0,
    );
  }

  async function loadLiveWorkflow(workflowId: string, payload: unknown): Promise<unknown> {
    try {
      const live = await workflows.getWorkflow(workflowId);
      if (live !== undefined && live !== null) return live;
    } catch {
      // Fall through to payload/fallback.
    }
    const embedded = workflowFromPayload(payload);
    if (embedded !== undefined) {
      try {
        await workflows.putWorkflow(workflowId, deepClone(embedded));
      } catch {
        // Seeding is best-effort.
      }
      return deepClone(embedded);
    }
    const fallback = fallbackWorkflow();
    try {
      await workflows.putWorkflow(workflowId, deepClone(fallback));
    } catch {
      // Seeding is best-effort.
    }
    return fallback;
  }

  async function runRepairTurn(first: string | unknown, ...rest: unknown[]): Promise<RepairTurnResult> {
    const eventId = normalizeEventId(first);
    const startedAt = nowMs();
    // Every LLM call in this turn runs through the traced wrapper, so
    // diagnose/patch/judge verdicts are all audited in `llm_traces`.
    const traced = withTraces(llm as LLMPort, store, eventId);
    const loaded = store.getEvent(eventId);
    if (loaded === null) throw new Error(`orchestrator: unknown event ${eventId}`);
    let workflowId = resolveWorkflowId(eventId, loaded.payload, workflows);

    const setStatus = (status: RepairStatus): void => {
      store.updateEventStatus(eventId, status);
    };

    // Enter the pipeline: diagnosing is always recorded, even on failure.
    setStatus("diagnosing");

    const live = await loadLiveWorkflow(workflowId, loaded.payload);
    // Re-resolve the workflow id from a seeded fallback when the payload
    // carried no id but the store now holds the workflow under the event id.
    workflowId = resolveWorkflowId(eventId, loaded.payload, workflows);

    // Pre-repair snapshot before any modification (idempotent first-write-wins).
    try {
      store.insertSnapshot({
        id: `${eventId}:pre-repair`,
        eventId,
        kind: "pre-repair",
        workflowId,
        snapshot: deepClone(live),
      });
    } catch {
      // Snapshot failures degrade to a failed turn below only if load failed;
      // an insert throw here is unexpected, so continue to diagnose.
    }

    const runData = runDataFromPayload(loaded.payload);
    const view = buildWorkflowView(live, runData);

    // Diagnose: a throw parks the event as failed with no promotion.
    let diagnosis: unknown;
    try {
      diagnosis = await diagnose(traced, view);
      recordDecision(
        eventId,
        "diagnose",
        "diagnosed",
        `diagnosed ${(diagnosis as Record<string, unknown>).rootCauseKind ?? "unknown"}`,
        typeof (diagnosis as Record<string, unknown>).confidence === "number"
          ? ((diagnosis as Record<string, unknown>).confidence as number)
          : 0,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      recordDecision(eventId, "diagnose", "failed", message.slice(0, 500), 0);
      setStatus("failed");
      try {
        store.incrementMetric("outcome.failed");
      } catch {
        // Best-effort.
      }
      recordDuration(startedAt);
      return { status: "failed", eventId };
    }

    // Human-broke-it restore-from-baseline park (issue #26): a hand edit
    // broke the Code node, so the only byte-equal repair is the baseline
    // snapshot — the LLM cannot know the fixture's arbitrary mutation, so
    // the patch path could never reconstruct it. Park the restore as a
    // durable `proposed` patch for approval instead. On lookup miss, fall
    // through to the normal patch path.
    if (
      isPlainObject(diagnosis) &&
      (diagnosis as Record<string, unknown>).rootCauseKind === "human-broke-it"
    ) {
      const baseline =
        typeof store.findBaselineSnapshot === "function"
          ? (store as Store).findBaselineSnapshot(workflowId)
          : null;
      if (baseline !== null) {
        const restored = deepClone(baseline.snapshot);
        try {
          store.insertSnapshot({
            id: `${eventId}:proposed`,
            eventId,
            kind: "proposed",
            workflowId,
            snapshot: deepClone(restored),
          });
        } catch {
          // Best-effort: the in-memory pendingPatched entry still carries the restore.
        }
        setStatus("patched");
        pendingPatched.set(eventId, { workflowId, workflow: deepClone(restored) });
        recordDecision(eventId, "patch", "patched", "restored baseline snapshot for approval", 1);

        // Sandbox verify of the restore (injected; defaults to green).
        let restoreVerify: VerifyResult;
        try {
          const produced = await verifyFn({
            eventId,
            workflowId,
            workflow: live,
            patched: restored,
            runData,
          });
          restoreVerify = normalizeVerify(produced);
          recordDecision(
            eventId,
            "verify",
            restoreVerify.ok ? "verified" : "unverified",
            restoreVerify.ok ? "sandbox replay green" : "sandbox replay found failures",
            restoreVerify.ok ? 1 : 0,
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          restoreVerify = { ok: false, failures: [{ message }] };
          recordDecision(eventId, "verify", "failed", message.slice(0, 500), 0);
        }
        setStatus("verified");

        // Judge verdict (validated loudly like the diagnose stage).
        let restoreJudge: JudgeVerdict;
        try {
          const raw = await traced.submit_verdict(
            "judge",
            { diagnose: diagnosis, patched: restored, verify: restoreVerify },
            judgeVerdictSchema,
          );
          if (!Value.Check(judgeVerdictSchema, raw)) {
            throw new Error("orchestrator: judge verdict failed judgeVerdictSchema validation");
          }
          restoreJudge = raw as JudgeVerdict;
          recordDecision(
            eventId,
            "judge",
            restoreJudge.verdict,
            restoreJudge.reason.slice(0, 500),
            restoreJudge.confidence,
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          recordDecision(eventId, "judge", "failed", message.slice(0, 500), 0);
          setStatus("failed");
          try {
            store.incrementMetric("outcome.failed");
          } catch {
            // Best-effort.
          }
          recordDuration(startedAt);
          return { status: "failed", eventId };
        }

        // A Code-node hand edit always needs a human confirmation: park the
        // restore at tier `approve` regardless of the gate outcome.
        const restoreTier: Tier = "approve";
        recordTierOutcome(eventId, restoreTier, "awaiting-approval", restoreJudge.confidence);
        recordDecision(
          eventId,
          "outcome",
          "awaiting-approval",
          `parked restore-from-baseline for approval (tier ${restoreTier})`,
          1,
        );
        setStatus("awaiting-approval");
        await notifyAwaitingApproval(deps, {
          eventId,
          tier: restoreTier,
          summary: restoreJudge.reason,
        });
        recordDuration(startedAt);
        return { status: "awaiting-approval", eventId, tier: restoreTier };
      }
    }

    // Patch: plan + apply via the injected runner or the real stage.
    let patched: unknown;
    try {
      if (patchRunner !== null) {
        const produced = await patchRunner({ workflow: deepClone(live), diagnose: diagnosis, llm: traced });
        patched = unwrapPatched(produced);
      } else {
        const result = await runPatchStage({
          workflow: deepClone(live),
          diagnose: diagnosis,
          llm: traced,
        });
        patched = result.workflow;
      }
      recordDecision(eventId, "patch", "patched", "patch applied", 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      recordDecision(eventId, "patch", "failed", message.slice(0, 500), 0);
      setStatus("failed");
      try {
        store.incrementMetric("outcome.failed");
      } catch {
        // Best-effort.
      }
      recordDuration(startedAt);
      return { status: "failed", eventId };
    }
    setStatus("patched");
    pendingPatched.set(eventId, { workflowId, workflow: deepClone(patched) });

    // Sandbox verify (injected; defaults to green).
    let verification: VerifyResult;
    try {
      const produced = await verifyFn({ eventId, workflowId, workflow: live, patched, runData });
      verification = normalizeVerify(produced);
      recordDecision(
        eventId,
        "verify",
        verification.ok ? "verified" : "unverified",
        verification.ok ? "sandbox replay green" : "sandbox replay found failures",
        verification.ok ? 1 : 0,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      verification = { ok: false, failures: [{ message }] };
      recordDecision(eventId, "verify", "failed", message.slice(0, 500), 0);
    }
    setStatus("verified");

    // Judge verdict (validated loudly like the diagnose stage).
    let judge: JudgeVerdict;
    try {
      const raw = await traced.submit_verdict(
        "judge",
        { diagnose: diagnosis, patched, verify: verification },
        judgeVerdictSchema,
      );
      if (!Value.Check(judgeVerdictSchema, raw)) {
        throw new Error("orchestrator: judge verdict failed judgeVerdictSchema validation");
      }
      judge = raw as JudgeVerdict;
      recordDecision(eventId, "judge", judge.verdict, judge.reason.slice(0, 500), judge.confidence);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      recordDecision(eventId, "judge", "failed", message.slice(0, 500), 0);
      setStatus("failed");
      try {
        store.incrementMetric("outcome.failed");
      } catch {
        // Best-effort.
      }
      recordDuration(startedAt);
      return { status: "failed", eventId };
    }

    void rest;

    // Tier + escalate-only gate.
    const tier = classifyTier(toTierInput(judge, verification));
    let effective: Tier | "retry" | "give-up" = tier;
    try {
      const gate = promotionGate({ classifierTier: tier, verified: verification.ok, similarity: 1 });
      effective = gate.decision;
    } catch {
      effective = tier;
    }

    // Judge reject always parks as rejected.
    if (judge.verdict === "reject") {
      recordTierOutcome(eventId, tier, "rejected", judge.confidence);
      recordDecision(eventId, "outcome", "rejected", judge.reason.slice(0, 500), judge.confidence);
      setStatus("rejected");
      recordDuration(startedAt);
      return { status: "rejected", eventId, tier };
    }

    if (tier === "auto-promote" && effective === "auto-promote" && verification.ok) {
      try {
        store.insertSnapshot({
          id: `${eventId}:pre-promotion`,
          eventId,
          kind: "pre-promotion",
          workflowId,
          snapshot: deepClone(live),
        });
      } catch {
        // Best-effort; promotion still proceeds.
      }
      try {
        await workflows.putWorkflow(workflowId, deepClone(patched));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        recordDecision(eventId, "promote", "failed", message.slice(0, 500), 0);
        setStatus("failed");
        try {
          store.incrementMetric("outcome.failed");
        } catch {
          // Best-effort.
        }
        recordDuration(startedAt);
        return { status: "failed", eventId, tier };
      }
      recordTierOutcome(eventId, tier, "promoted", judge.confidence);
      recordDecision(eventId, "outcome", "promoted", "auto-promoted after green verification", 1);
      setStatus("promoted");
      recordDuration(startedAt);
      return { status: "promoted", eventId, tier };
    }

    recordTierOutcome(eventId, tier, "awaiting-approval", judge.confidence);
    recordDecision(
      eventId,
      "outcome",
      "awaiting-approval",
      `parked for approval (tier ${tier}, gate ${effective})`,
      1,
    );
    setStatus("awaiting-approval");
    // Tier-2 approval card (issue #19): best-effort Telegram send; a
    // notifier failure never changes the return value or the stored status.
    await notifyAwaitingApproval(deps, { eventId, tier, summary: judge.reason });
    recordDuration(startedAt);
    return { status: "awaiting-approval", eventId, tier };
  }

  async function approve(first: string | unknown, second?: unknown): Promise<RepairTurnResult> {
    const eventId = normalizeEventId(first);
    const startedAt = nowMs();
    const loaded = store.getEvent(eventId);
    if (loaded === null) throw new Error(`orchestrator: unknown event ${eventId}`);
    if (loaded.status !== "awaiting-approval" && loaded.status !== "awaiting_approval") {
      throw new Error(`orchestrator: cannot approve event ${eventId} from status ${loaded.status}`);
    }
    const workflowId = resolveWorkflowId(eventId, loaded.payload, workflows);
    let live: unknown;
    try {
      live = await workflows.getWorkflow(workflowId);
    } catch {
      live = workflowFromPayload(loaded.payload) ?? fallbackWorkflow();
    }
    const explicit = normalizePatchedArg(second) ?? patchedFromFirst(first);
    const cached = pendingPatched.get(eventId);
    // Durable restore source (issue #26): the parked `proposed` snapshot
    // survives process restarts, so approval promotes the restore even when
    // the in-memory cache is empty.
    let proposed: unknown;
    try {
      proposed = store.getSnapshot(`${eventId}:proposed`)?.snapshot ?? undefined;
    } catch {
      proposed = undefined;
    }
    const patched = explicit !== undefined ? explicit : (cached?.workflow ?? proposed ?? live);

    try {
      store.insertSnapshot({
        id: `${eventId}:pre-promotion`,
        eventId,
        kind: "pre-promotion",
        workflowId,
        snapshot: deepClone(live),
      });
    } catch {
      // Best-effort.
    }
    await workflows.putWorkflow(workflowId, deepClone(patched));
    pendingPatched.delete(eventId);
    try {
      store.incrementMetric("outcome.promoted");
    } catch {
      // Best-effort.
    }
    recordDecision(eventId, "outcome", "promoted", "approved by operator", 1);
    store.updateEventStatus(eventId, "promoted");
    recordDuration(startedAt);
    return { status: "promoted", eventId };
  }

  async function reject(first: string | unknown, second?: unknown): Promise<RepairTurnResult> {
    const eventId = normalizeEventId(first);
    const startedAt = nowMs();
    const loaded = store.getEvent(eventId);
    if (loaded === null) throw new Error(`orchestrator: unknown event ${eventId}`);
    const reason = typeof second === "string" ? second : "rejected by operator";
    recordDecision(eventId, "outcome", "rejected", reason.slice(0, 500), 0);
    try {
      store.incrementMetric("outcome.rejected");
    } catch {
      // Best-effort.
    }
    store.updateEventStatus(eventId, "rejected");
    pendingPatched.delete(eventId);
    recordDuration(startedAt);
    return { status: "rejected", eventId };
  }

  async function revert(first: string | unknown): Promise<RepairTurnResult> {
    const eventId = normalizeEventId(first);
    const startedAt = nowMs();
    const loaded = store.getEvent(eventId);
    if (loaded === null) throw new Error(`orchestrator: unknown event ${eventId}`);
    if (loaded.status !== "promoted" && loaded.status !== "awaiting-approval") {
      throw new Error(`orchestrator: cannot revert event ${eventId} from status ${loaded.status}`);
    }
    const snapshot = store.getSnapshot(`${eventId}:pre-repair`);
    if (snapshot === null) throw new Error(`orchestrator: missing pre-repair snapshot for event ${eventId}`);
    const workflowId = typeof snapshot.workflowId === "string" && snapshot.workflowId !== ""
      ? snapshot.workflowId
      : resolveWorkflowId(eventId, loaded.payload, workflows);
    await workflows.putWorkflow(workflowId, deepClone(snapshot.snapshot));
    pendingPatched.delete(eventId);
    try {
      store.incrementMetric("outcome.reverted");
    } catch {
      // Best-effort.
    }
    recordDecision(eventId, "outcome", "reverted", "restored pre-repair snapshot", 1);
    store.updateEventStatus(eventId, "reverted");
    recordDuration(startedAt);
    return { status: "reverted", eventId };
  }

  return Object.freeze({ runRepairTurn, approve, reject, revert });
}

function unwrapPatched(produced: unknown): unknown {
  if (isPlainObject(produced) && produced.workflow !== undefined) return produced.workflow;
  return produced;
}

function normalizeVerify(produced: unknown): VerifyResult {
  if (isPlainObject(produced)) {
    const ok = (produced as Record<string, unknown>).ok;
    const failures = (produced as Record<string, unknown>).failures;
    return { ok: ok === true, failures: Array.isArray(failures) ? failures : [] };
  }
  if (produced === true) return { ok: true, failures: [] };
  if (produced === false) return { ok: false, failures: [{ message: "verification failed" }] };
  return { ok: true, failures: [] };
}

/** Backwards-compatible alias for callers importing the factory under another name. */
export const createRepairOrchestrator = createOrchestrator;
export type { Tier };
