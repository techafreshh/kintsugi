/**
 * `kintsugi fix` inline repair entrypoint (issue #23): loads `Settings`,
 * opens the store, builds the real `N8nClient` + `createLLM` port, fetches
 * the failing execution from n8n (unknown id exits 1 with `not found` on
 * stderr), then runs the existing orchestrator pipeline inline exactly once
 * via `createOrchestrator(...).runRepairTurn()` — no worker loop, no new
 * pipeline — and prints a verdict report to stdout. Exit 0 on any completed
 * turn; exit 1 only when the pipeline threw (or the execution/n8n wiring
 * was missing). Import-safe under vitest: `main()` only runs when the built
 * file is executed directly.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadSettings, type Settings } from "../config/settings.js";
import { diffWorkflows } from "../diff/workflowDiff.js";
import { createLLM, type LLMPort } from "../llm/port.js";
import { N8nClient } from "../n8n/client.js";
import {
  createOrchestrator,
  type RepairTurnResult,
  type VerifyFn,
  type VerifyInput,
  type VerifyResult,
} from "../orchestrator/orchestrator.js";
import { runSandbox } from "../sandbox/harness.js";
import { deriveExpectations, verify as verifyRows } from "../sandbox/verify.js";
import { openStore, type Store } from "../store/store.js";

/** Minimal n8n surface `fix` needs; tests inject fakes of this shape. */
export interface FixClient {
  getExecution(id: string): unknown | Promise<unknown>;
  getWorkflow?(id: string): unknown | Promise<unknown>;
  updateWorkflow?(id: string, workflow: unknown): unknown | Promise<unknown>;
  [key: string]: unknown;
}

/** Injectable overrides; production passes none (everything comes from env). */
export interface RunFixOverrides {
  store?: Store;
  settings?: Settings;
  llm?: LLMPort;
  client?: FixClient;
  verifyFn?: VerifyFn;
  workflows?: unknown;
}

export interface RunFixResult {
  exitCode: number;
  report: string;
}

/**
 * Run one inline repair turn for `executionId` and print the verdict report
 * to stdout. Errors (missing id, unconfigured n8n, unknown execution,
 * thrown turn) go to stderr with exit 1; the returned `report` carries the
 * stdout text on success and the error text on failure.
 */
export async function runFix(
  executionId: string,
  overrides: RunFixOverrides = {},
): Promise<RunFixResult> {
  const startedAt = Date.now();
  const settings = overrides.settings ?? loadSettings();
  const store = overrides.store ?? openStore(settings.dbPath ?? "kintsugi.db");
  const ownsStore = overrides.store === undefined;
  try {
    const fail = (message: string): RunFixResult => {
      console.error(message);
      return { exitCode: 1, report: message };
    };
    if (typeof executionId !== "string" || executionId.trim() === "") {
      return fail("kintsugi fix: missing <execution-id> (usage: kintsugi fix <execution-id>)");
    }
    const id = executionId;
    const llm = overrides.llm ?? createLLM(process.env);

    // Injected stub wins (tests); otherwise the real client when both n8n
    // settings are present.
    let client: FixClient | undefined = overrides.client;
    if (
      client === undefined &&
      settings.n8nBaseUrl !== undefined &&
      settings.n8nApiKey !== undefined
    ) {
      client = new N8nClient({ baseUrl: settings.n8nBaseUrl, apiKey: settings.n8nApiKey }) as unknown as FixClient;
    }

    // Fetch the failing execution first so an unknown id exits 1 before any
    // turn runs. The store row is first-write-wins: a re-run keeps the
    // original payload.
    if (client !== undefined) {
      let execution: unknown;
      try {
        execution = await client.getExecution(id);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/not found/i.test(message)) {
          return fail(`kintsugi fix: execution "${id}" not found (${message})`);
        }
        return fail(`kintsugi fix: cannot load execution "${id}" (${message})`);
      }
      try {
        store.insertEvent({ executionId: id, payload: execution });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return fail(`kintsugi fix: cannot record execution "${id}" (${message})`);
      }
    } else if (store.getEvent(id) === null) {
      // No n8n client (injected-workflows tests): synthesize the event so the
      // inline turn still runs without network. Production always has a
      // client here; without one and without an injected workflow store
      // there is nothing to repair.
      if (overrides.workflows === undefined) {
        return fail(
          "kintsugi fix: n8n: base URL / API key not configured (set N8N_BASE_URL and N8N_API_KEY)",
        );
      }
      store.insertEvent({ executionId: id, payload: { executionId: id } });
    }

    // Workflow storage: injected override wins, otherwise adapt the n8n
    // client to the orchestrator `get/putWorkflow` shape.
    let workflows: unknown = overrides.workflows;
    if (workflows === undefined) {
      if (client === undefined) {
        return fail(
          "kintsugi fix: n8n: base URL / API key not configured (set N8N_BASE_URL and N8N_API_KEY)",
        );
      }
      const n8n = client;
      workflows = {
        getWorkflow: (workflowId: string): Promise<unknown> =>
          Promise.resolve(n8n.getWorkflow?.(workflowId)),
        putWorkflow: (workflowId: string, workflow: unknown): Promise<unknown> =>
          Promise.resolve(
            (n8n as { updateWorkflow(id: string, workflow: unknown): unknown }).updateWorkflow(
              workflowId,
              workflow,
            ),
          ),
      };
    }

    // Capture the patched workflow plus the verification verdict so the
    // report can diff intended ops even when the turn parks for approval.
    let seenPatched: unknown;
    let lastVerify: VerifyResult | undefined;
    const baseVerify: VerifyFn =
      overrides.verifyFn ?? ((input: VerifyInput) => defaultVerifyFn(client, input));
    const verifyFn: VerifyFn = async (input: VerifyInput) => {
      seenPatched = input.patched;
      lastVerify = normalizeVerifyResult(await baseVerify(input));
      return lastVerify;
    };

    const orchestrator = createOrchestrator({ store, llm, workflows, verifyFn, settings });
    let result: RepairTurnResult;
    try {
      result = await orchestrator.runRepairTurn(id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return fail(`kintsugi fix: repair turn for "${id}" threw (${message})`);
    }
    const durationMs = Date.now() - startedAt;
    const report = await buildReport({
      executionId: id,
      result,
      store,
      workflows,
      seenPatched,
      lastVerify,
      durationMs,
    });
    console.log(report);
    return { exitCode: 0, report };
  } finally {
    if (ownsStore) {
      try {
        store.close();
      } catch {
        // Close is best-effort; the turn result stands regardless.
      }
    }
  }
}

/**
 * Real sandbox verification: replay the patched workflow through the
 * harness against n8n, then fold the replayed rows through `verify` with
 * expectations distilled from the failing run data. Transport failures
 * become `{ ok: false }` rather than throws, mirroring harness conventions.
 */
async function defaultVerifyFn(
  client: FixClient | undefined,
  input: VerifyInput,
): Promise<VerifyResult> {
  try {
    const sandboxResult = await runSandbox({
      workflowId: input.workflowId,
      snapshot: input.patched,
      needleId: input.eventId,
      client,
      triggerPayload: input.runData,
    });
    if (typeof sandboxResult.error === "string" && sandboxResult.error !== "") {
      return { ok: false, failures: [{ message: sandboxResult.error }] };
    }
    const rows = Array.isArray(sandboxResult.rows) ? sandboxResult.rows : [];
    const verdict = verifyRows(rows, deriveExpectations(input.runData));
    return { ok: verdict.ok, failures: verdict.failures };
  } catch (cause) {
    return {
      ok: false,
      failures: [{ message: cause instanceof Error ? cause.message : String(cause) }],
    };
  }
}

function normalizeVerifyResult(produced: unknown): VerifyResult {
  if (typeof produced === "object" && produced !== null) {
    const record = produced as { ok?: unknown; failures?: unknown };
    return {
      ok: record.ok === true,
      failures: Array.isArray(record.failures) ? record.failures : [],
    };
  }
  return {
    ok: produced === true,
    failures: produced === true ? [] : [{ message: "verification failed" }],
  };
}

interface ReportInput {
  executionId: string;
  result: RepairTurnResult;
  store: Store;
  workflows: unknown;
  seenPatched: unknown;
  lastVerify: VerifyResult | undefined;
  durationMs: number;
}

/** Read-only stdout report derived from store rows plus a workflow diff. */
async function buildReport(input: ReportInput): Promise<string> {
  const { executionId, result, store } = input;
  const lines: string[] = [`kintsugi fix ${executionId}`, `tier: ${result.tier ?? "unknown"}`];

  const decisions = listSafely(() => store.listDecisions(executionId));
  const diagnose = decisions.find((decision) => decision.stage === "diagnose");
  if (diagnose !== undefined) {
    lines.push(
      `diagnosis: ${diagnose.verdict} ${diagnose.reason} (confidence ${diagnose.confidence})`,
    );
  } else {
    lines.push("diagnosis: unknown");
  }

  const snapshots = listSafely(() => store.listSnapshots(executionId));
  const preRepair = snapshots.find((snapshot) => snapshot.kind === "pre-repair");
  const prePromotion = snapshots.find((snapshot) => snapshot.kind === "pre-promotion");
  const before: unknown = preRepair?.snapshot;
  let after: unknown = input.seenPatched;
  if (after === undefined) {
    const workflowId =
      typeof preRepair?.workflowId === "string" && preRepair.workflowId !== ""
        ? preRepair.workflowId
        : executionId;
    after = await readLiveWorkflow(input.workflows, workflowId);
  }
  if (after === undefined) after = prePromotion?.snapshot ?? before;

  const diff = diffWorkflows(before ?? {}, after ?? {});
  lines.push(`applied ops (${diff.changedLineCount}):`);
  if (
    diff.changed.length === 0 &&
    diff.added.length === 0 &&
    diff.removed.length === 0
  ) {
    lines.push("  (no changes)");
  } else {
    for (const entry of diff.changed) lines.push(`  - ${entry.leafPath}`);
    for (const added of diff.added) lines.push(`  + nodes.${added.name} (added)`);
    for (const removed of diff.removed) lines.push(`  - nodes.${removed.name} (removed)`);
  }

  const failures = input.lastVerify?.failures;
  lines.push(
    `sandbox: ok=${input.lastVerify?.ok ?? "unknown"} failures=${Array.isArray(failures) ? failures.length : 0}`,
  );
  // Promoted turns print the mapped word the ops report greps for.
  lines.push(`status: ${result.status === "promoted" ? "auto-promoted" : result.status}`);
  lines.push(`duration_ms: ${Number.isFinite(input.durationMs) ? input.durationMs : 0}`);
  lines.push(`llm traces: ${listSafely(() => store.listTraces(executionId)).length}`);
  return lines.join("\n");
}

/** Best-effort live workflow read for the diff; never throws. */
async function readLiveWorkflow(workflows: unknown, workflowId: string): Promise<unknown> {
  try {
    if (workflows instanceof Map) return workflows.get(workflowId);
    if (typeof workflows === "object" && workflows !== null) {
      const get = (workflows as { getWorkflow?: unknown }).getWorkflow;
      if (typeof get === "function") {
        return await (get as (id: string) => Promise<unknown>)(workflowId);
      }
    }
  } catch {
    // Best-effort: the diff falls back to snapshots below.
  }
  return undefined;
}

function listSafely<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const executionId = argv[2];
  if (typeof executionId !== "string" || executionId.trim() === "") {
    console.error("Usage: kintsugi fix <execution-id>");
    process.exit(1);
    return;
  }
  try {
    const { exitCode } = await runFix(executionId);
    process.exit(exitCode);
  } catch (cause) {
    console.error(
      `kintsugi fix: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exit(1);
  }
}

/**
 * Direct-execution guard surviving bin symlinks: `argv[1]` keeps the symlink
 * path while `import.meta.url` carries the resolved real path (mirrors
 * `src/cli.ts`), so importing this module under vitest never runs the CLI.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(`kintsugi fix: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
