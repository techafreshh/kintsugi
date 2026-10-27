/**
 * Pinned contract (issue #15): sandbox replay harness for patch validation.
 * `runSandbox` copies the patched workflow into the target n8n as a new
 * workflow prefixed `sandbox-`, swaps production triggers for one pinned
 * manual trigger, runs it via the run endpoint when `probeRunEndpoint`
 * reports it (falling back to a webhook+secret attempt), captures the
 * execution result, then deletes the copy unless `sandboxKeep === true`.
 * Duck-typed over `MinimalSandboxClient` (the structural subset of
 * `N8nClient` the harness needs) plus an injectable `fetch`, so HTTP-stub
 * and in-memory-fake tests both work without touching `N8nClient`. Transport
 * failures are captured on the result, never thrown, so cleanup still runs;
 * only missing input (`workflowId`, `client`) throws. This module never
 * touches `process.env`; callers inject every value. Egress findings are
 * warn-only metadata on the result.
 */

import type { N8nClient } from "../n8n/client.js";

/** Structural subset of `N8nClient` the harness needs; extra methods ignored. */
export interface MinimalSandboxClient {
  getWorkflow(id: string): Promise<Record<string, unknown>>;
  createWorkflow(json: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteWorkflow(id: string): Promise<Record<string, unknown>>;
  probeRunEndpoint(id: string): Promise<boolean>;
  runWorkflow?: (...args: unknown[]) => Promise<unknown>;
  getExecution?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  listWorkflows?: (...args: unknown[]) => Promise<unknown>;
}

/** Any client the harness accepts: the pinned client or a structural fake. */
export type SandboxClient = MinimalSandboxClient | N8nClient;

/** Which transport produced the replay result. */
export type SandboxStrategy = "run-endpoint" | "webhook-fallback";

/** Warn-only egress finding attached to every sandbox result. */
export interface SandboxEgress {
  allowed: boolean;
  violations: string[];
}

/** Flexible `runSandbox` input: object form plus positional aliases. */
export interface RunSandboxInput {
  workflowId?: unknown;
  snapshot?: unknown;
  snapshotJson?: unknown;
  needleId?: unknown;
  needle?: unknown;
  executionId?: unknown;
  client?: unknown;
  n8n?: unknown;
  sandboxKeep?: unknown;
  keep?: unknown;
  triggerPayload?: unknown;
  payload?: unknown;
  webhookUrl?: unknown;
  webhookSecret?: unknown;
  fetchFn?: unknown;
  fetch?: unknown;
  egressAllowlist?: unknown;
  [key: string]: unknown;
}

/** Captured replay result; `strategy` is always present. */
export interface SandboxResult {
  strategy: SandboxStrategy;
  sandboxWorkflowId: string;
  /** Alias for `sandboxWorkflowId`. */
  sandboxId: string;
  sandboxName: string;
  /** Alias for `sandboxName`. */
  sandboxWorkflowName: string;
  /** Replayed rows (possibly empty when no transport could capture output). */
  rows: unknown[];
  /** Alias for `rows`. */
  output: unknown[];
  /** Alias for `rows`. */
  data: unknown[];
  egress: SandboxEgress;
  /** Transport/execution failure text; absent on a clean run. */
  error?: string;
  /** Raw execution payload when a transport returned one, else null. */
  execution: unknown;
}

/** Pinned manual trigger replacing every production trigger/webhook node. */
const SANDBOX_TRIGGER_NAME = "Sandbox Manual Trigger";
const SANDBOX_TRIGGER_TYPE = "n8n-nodes-base.manualTrigger";

/**
 * Deep-clone the workflow, remove every node whose `type` mentions
 * `trigger` or `webhook` (case-insensitive), prepend one pinned
 * `Sandbox Manual Trigger` node, and prune `connections` entries keyed by
 * (or targeting) removed names. Never mutates the input; malformed input
 * yields a workflow carrying just the pinned trigger.
 */
export function swapToManualTrigger(workflow: unknown): Record<string, unknown> {
  const root = deepClone(workflow);
  if (!isPlainObject(root)) {
    return { name: "", nodes: [manualTriggerNode()], connections: {} };
  }
  const removed = new Set<string>();
  if (Array.isArray(root.nodes)) {
    const kept: unknown[] = [];
    for (const node of root.nodes) {
      if (isTriggerNode(node)) {
        const name = nodeName(node);
        if (name !== "") removed.add(name);
        continue;
      }
      kept.push(node);
    }
    if (!kept.some((node) => isPlainObject(node) && node.name === SANDBOX_TRIGGER_NAME)) {
      kept.unshift(manualTriggerNode());
    }
    root.nodes = kept;
  } else if (isPlainObject(root.nodes)) {
    for (const [key, node] of Object.entries(root.nodes)) {
      if (isTriggerNode(node)) {
        const name =
          isPlainObject(node) && typeof node.name === "string" && node.name !== ""
            ? node.name
            : key;
        removed.add(name);
        delete root.nodes[key];
      }
    }
    if (!Object.hasOwn(root.nodes, SANDBOX_TRIGGER_NAME)) {
      root.nodes = { [SANDBOX_TRIGGER_NAME]: manualTriggerNode(), ...root.nodes };
    }
  } else {
    root.nodes = [manualTriggerNode()];
  }
  if (isPlainObject(root.connections)) {
    root.connections = pruneConnections(root.connections, removed);
  }
  return root;
}

/**
 * Scan node `parameters` (plus `webhookUrl` fields) for `http(s)` URLs whose
 * host is not on the allowlist. Warn-only: malformed input yields no
 * violations, and the finding never throws — callers proceed regardless.
 */
export function checkSandboxEgress(workflow: unknown, allowlist?: unknown): SandboxEgress {
  try {
    const allowed = normalizeAllowlist(allowlist);
    const found = new Set<string>();
    for (const node of iterateNodes(workflow)) {
      collectUrls(node.parameters, found);
      collectUrls(node.webhookUrl, found);
      collectUrls(node.webhookUrls, found);
    }
    const violations = [...found].filter((url) => !allowed.has(hostOf(url)));
    return { allowed: violations.length === 0, violations };
  } catch {
    return { allowed: true, violations: [] };
  }
}

/**
 * Copy the patched workflow into n8n as `sandbox-<name>`, replay the failing
 * execution's trigger payload through the run endpoint (or the webhook
 * fallback), capture the result, and delete the copy unless
 * `sandboxKeep === true`. Accepts the object input plus the positional shape
 * `(workflowId, snapshotJson, needleId, clientOrOptions?)`. The returned
 * result always carries `strategy`; transport failures land in `error`
 * instead of throwing, and cleanup still runs.
 */
export async function runSandbox(
  inputOrWorkflowId: RunSandboxInput | unknown,
  ...rest: unknown[]
): Promise<SandboxResult> {
  const input = normalizeSandboxInput(inputOrWorkflowId, rest);
  const workflowId = takeWorkflowId(input);
  const client = resolveClient(input);
  const snapshotRaw = takeSnapshot(input);
  const needleId = takeNeedleId(input);
  const keep = input.sandboxKeep === true || input.keep === true;
  const fetchFn = takeFetchFn(input);
  const webhookUrl = takeString(input.webhookUrl ?? (input as Record<string, unknown>).webhookURL);
  const webhookSecret = takeString(
    input.webhookSecret ?? (input as Record<string, unknown>).webhooksecret,
  );
  const explicitPayload = input.triggerPayload ?? input.payload;
  const allowlist = input.egressAllowlist ?? input.allowlist ?? input.allowedHosts;

  let fetched: Record<string, unknown> | undefined;
  try {
    fetched = await client.getWorkflow(workflowId);
  } catch {
    fetched = undefined;
  }

  const parsedSnapshot = parseMaybeJson(snapshotRaw);
  const base: unknown =
    parsedSnapshot !== undefined ? parsedSnapshot : fetched !== undefined ? fetched : {};
  const cloned = deepClone(base);
  const seed: Record<string, unknown> = isPlainObject(cloned) ? cloned : {};

  const sandboxWorkflow = swapToManualTrigger(seed);
  const originalName =
    takeString(fetched?.name) ?? takeString((isPlainObject(parsedSnapshot) ? parsedSnapshot.name : undefined)) ?? workflowId;
  const sandboxName =
    originalName.startsWith("sandbox-") && originalName.length > "sandbox-".length
      ? originalName
      : `sandbox-${originalName}`;
  sandboxWorkflow.name = sandboxName;
  sandboxWorkflow.active = false;

  const egress = checkSandboxEgress(sandboxWorkflow, allowlist);

  let created: Record<string, unknown>;
  try {
    created = await client.createWorkflow(sandboxWorkflow);
  } catch (cause) {
    const empty: SandboxResult = {
      strategy: "webhook-fallback",
      sandboxWorkflowId: "",
      sandboxId: "",
      sandboxName,
      sandboxWorkflowName: sandboxName,
      rows: [],
      output: [],
      data: [],
      egress,
      execution: null,
      error: describeValue(cause),
    };
    return empty;
  }
  const sandboxId = await takeSandboxId(created, sandboxName, client);

  let payload: unknown = explicitPayload;
  if (
    (payload === undefined || (isPlainObject(payload) && Object.keys(payload).length === 0)) &&
    typeof needleId === "string" &&
    needleId !== "" &&
    typeof client.getExecution === "function"
  ) {
    try {
      const execution = await client.getExecution(needleId);
      payload = extractTriggerPayload(execution) ?? payload;
    } catch {
      // Best-effort replay context; the run proceeds with the explicit payload.
    }
  }
  if (payload === undefined) payload = {};

  let probe = false;
  try {
    probe = sandboxId === "" ? false : await client.probeRunEndpoint(sandboxId);
  } catch {
    probe = false;
  }
  const strategy: SandboxStrategy = probe ? "run-endpoint" : "webhook-fallback";

  let rows: unknown[] = [];
  let rawExecution: unknown = null;
  let execError: string | undefined;
  try {
    if (typeof client.runWorkflow === "function" && sandboxId !== "") {
      rawExecution = await client.runWorkflow(sandboxId, payload);
      rows = collectSandboxRows(rawExecution);
    } else if (strategy === "webhook-fallback" && webhookUrl && fetchFn) {
      rawExecution = await postWebhook(fetchFn, webhookUrl, webhookSecret, payload);
      rows = collectSandboxRows(rawExecution);
    } else {
      rows = [];
    }
  } catch (cause) {
    execError = describeValue(cause);
    rows = [];
    rawExecution = null;
  }

  if (!keep && sandboxId !== "") {
    try {
      await client.deleteWorkflow(sandboxId);
    } catch {
      // Cleanup is best-effort; the captured result stands regardless.
    }
  }

  const result: SandboxResult = {
    strategy,
    sandboxWorkflowId: sandboxId,
    sandboxId,
    sandboxName,
    sandboxWorkflowName: sandboxName,
    rows,
    output: rows,
    data: rows,
    egress,
    execution: rawExecution,
  };
  if (execError !== undefined) result.error = execError;
  return result;
}

/**
 * Accept the documented object input plus the positional shapes
 * `(workflowId, snapshot, needleId, clientOrOptions)` and
 * `(workflow, options)`, so HTTP-stub and in-memory-fake callers share one
 * entry point. Unrecognized shapes fall through with the fields they carry;
 * missing required values surface later as typed errors, never raw
 * TypeErrors from property access.
 */
function normalizeSandboxInput(first: unknown, rest: unknown[]): RunSandboxInput {
  if (rest.length === 0) {
    if (isPlainObject(first) && hasSandboxKeys(first)) return { ...(first as RunSandboxInput) };
    if (isPlainObject(first) && !hasSandboxKeys(first) && Object.hasOwn(first, "nodes")) {
      return { snapshot: first };
    }
    if (isPlainObject(first)) return { ...(first as RunSandboxInput) };
    return { workflowId: first };
  }
  if (typeof first === "string") {
    const input: RunSandboxInput = { workflowId: first };
    if (rest.length >= 1) input.snapshot = rest[0];
    if (rest.length >= 2) input.needleId = rest[1];
    for (const extra of rest.slice(2)) absorbExtra(input, extra);
    return input;
  }
  if (isPlainObject(first)) {
    const options = rest.find(isPlainObject) as RunSandboxInput | undefined;
    if (options !== undefined && Object.hasOwn(first, "nodes")) {
      const merged: RunSandboxInput = { ...options };
      if (merged.snapshot === undefined && merged.snapshotJson === undefined) {
        merged.snapshot = first;
      }
      for (const extra of rest) {
        if (extra === options) continue;
        absorbExtra(merged, extra);
      }
      return merged;
    }
    const merged: RunSandboxInput = { ...(first as RunSandboxInput) };
    for (const extra of rest) absorbExtra(merged, extra);
    return merged;
  }
  const merged: RunSandboxInput = { workflowId: first };
  if (rest.length >= 1) merged.snapshot = rest[0];
  if (rest.length >= 2) merged.needleId = rest[1];
  for (const extra of rest.slice(2)) absorbExtra(merged, extra);
  return merged;
}

/** Fold one trailing positional into the input: clients stick, objects merge. */
function absorbExtra(input: RunSandboxInput, value: unknown): void {
  if (value === undefined) return;
  if (isClientLike(value)) {
    if (input.client === undefined && input.n8n === undefined) input.client = value;
    return;
  }
  if (typeof value === "function") {
    if (input.fetchFn === undefined && input.fetch === undefined) input.fetchFn = value;
    return;
  }
  if (isPlainObject(value)) Object.assign(input, value);
}

function hasSandboxKeys(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "workflowId") ||
    Object.hasOwn(value, "snapshot") ||
    Object.hasOwn(value, "snapshotJson") ||
    Object.hasOwn(value, "needleId") ||
    Object.hasOwn(value, "needle") ||
    Object.hasOwn(value, "executionId") ||
    Object.hasOwn(value, "client") ||
    Object.hasOwn(value, "n8n")
  );
}

function takeWorkflowId(input: RunSandboxInput): string {
  const id = input.workflowId;
  if (typeof id === "string" && id !== "") return id;
  throw new TypeError("sandbox: workflowId is required");
}

function takeSnapshot(input: RunSandboxInput): unknown {
  const record = input as Record<string, unknown>;
  for (const key of ["snapshot", "snapshotJson", "workflow", "workflowJson", "patchedWorkflow"] as const) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function takeNeedleId(input: RunSandboxInput): unknown {
  const record = input as Record<string, unknown>;
  for (const key of ["needleId", "needle", "executionId", "failingExecutionId", "eventId"] as const) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function resolveClient(input: RunSandboxInput): MinimalSandboxClient {
  const candidates = [input.client, input.n8n, (input as Record<string, unknown>).n8nClient];
  for (const candidate of candidates) {
    if (isClientLike(candidate)) return candidate as MinimalSandboxClient;
  }
  const record = input as Record<string, unknown>;
  const baseUrl = takeString(record.baseUrl ?? record.baseURL ?? record.n8nBaseUrl);
  if (baseUrl !== undefined) {
    const apiKey = takeString(record.apiKey ?? record.n8nApiKey) ?? "";
    const fetchFn = takeFetchFn(input) ?? globalFetch();
    return httpClient(baseUrl, apiKey, fetchFn);
  }
  throw new TypeError(
    "sandbox: client is required (provide client/n8n with getWorkflow/createWorkflow/deleteWorkflow/probeRunEndpoint)",
  );
}

function isClientLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.getWorkflow === "function" ||
    typeof record.createWorkflow === "function" ||
    typeof record.deleteWorkflow === "function" ||
    typeof record.probeRunEndpoint === "function" ||
    typeof record.runWorkflow === "function"
  );
}

function takeFetchFn(input: RunSandboxInput): FetchFn | undefined {
  const record = input as Record<string, unknown>;
  for (const key of ["fetchFn", "fetch"] as const) {
    if (typeof record[key] === "function") return record[key] as FetchFn;
  }
  return globalFetch();
}

/** Sandbox id from the create response, falling back to a list lookup by name. */
async function takeSandboxId(
  created: Record<string, unknown>,
  sandboxName: string,
  client: MinimalSandboxClient,
): Promise<string> {
  const direct = takeString(created.id ?? created.sandboxWorkflowId ?? created.workflowId);
  if (direct !== undefined) return direct;
  if (typeof client.listWorkflows !== "function") return "";
  try {
    const listed = await client.listWorkflows();
    const entries = Array.isArray(listed)
      ? listed
      : isPlainObject(listed) && Array.isArray(listed.data)
        ? listed.data
        : [];
    for (const entry of entries) {
      if (isPlainObject(entry) && entry.name === sandboxName) {
        const found = takeString(entry.id ?? entry.workflowId);
        if (found !== undefined) return found;
      }
    }
  } catch {
    // Discovery is best-effort; the caller proceeds with an empty id.
  }
  return "";
}

type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<unknown>;

function globalFetch(): FetchFn | undefined {
  const fn = (globalThis as Record<string, unknown>).fetch;
  return typeof fn === "function" ? (fn as unknown as FetchFn) : undefined;
}

function takeString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Minimal HTTP client for callers passing `baseUrl` instead of a client. */
function httpClient(baseUrl: string, apiKey: string, fetchFn: FetchFn | undefined): MinimalSandboxClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== "") headers["x-n8n-api-key"] = apiKey;
  const run = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    if (fetchFn === undefined) throw new Error(`sandbox: ${method} ${path} needs a fetch implementation`);
    const response = (await fetchFn(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })) as { status: number; text?: () => Promise<string>; json?: () => Promise<unknown> };
    if (typeof response.json === "function") return (await response.json()) as Record<string, unknown>;
    if (typeof response.text === "function") {
      const text = await response.text();
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return isPlainObject(response) ? response : {};
  };
  return {
    getWorkflow: (id) => run("GET", `/api/v1/workflows/${id}`),
    createWorkflow: (json) => run("POST", "/api/v1/workflows", json),
    deleteWorkflow: (id) => run("DELETE", `/api/v1/workflows/${id}`),
    probeRunEndpoint: async (id) => {
      try {
        if (fetchFn === undefined) return false;
        const response = (await fetchFn(`${base}/api/v1/workflows/${id}/run`, {
          method: "POST",
          headers,
          body: "{}",
        })) as { status?: number };
        if (typeof response.status === "number") return response.status !== 404;
        return true;
      } catch {
        return false;
      }
    },
  };
}

function manualTriggerNode(): Record<string, unknown> {
  return {
    name: SANDBOX_TRIGGER_NAME,
    type: SANDBOX_TRIGGER_TYPE,
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
}

function isTriggerNode(node: unknown): boolean {
  if (!isPlainObject(node)) return false;
  return typeof node.type === "string" && /trigger|webhook/i.test(node.type);
}

function nodeName(node: unknown): string {
  if (isPlainObject(node) && typeof node.name === "string") return node.name;
  return "";
}

interface SandboxNodeView {
  parameters: unknown;
  webhookUrl: unknown;
  webhookUrls: unknown;
}

function iterateNodes(workflow: unknown): SandboxNodeView[] {
  if (!isPlainObject(workflow)) return [];
  const nodes = (workflow as Record<string, unknown>).nodes;
  const out: SandboxNodeView[] = [];
  const push = (node: unknown): void => {
    if (!isPlainObject(node)) return;
    out.push({
      parameters: node.parameters,
      webhookUrl: node.webhookUrl,
      webhookUrls: node.webhookUrls,
    });
  };
  if (Array.isArray(nodes)) {
    for (const node of nodes) push(node);
    return out;
  }
  if (isPlainObject(nodes)) {
    for (const node of Object.values(nodes)) push(node);
  }
  return out;
}

/** Drop connection entries keyed by (or targeting) removed node names. */
function pruneConnections(
  connections: Record<string, unknown>,
  removed: Set<string>,
): Record<string, unknown> {
  if (removed.size === 0) return connections;
  const pruned: Record<string, unknown> = {};
  for (const [source, byType] of Object.entries(connections)) {
    if (removed.has(source) || !isPlainObject(byType)) continue;
    const keptByType: Record<string, unknown> = {};
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      const keptOutputs: unknown[] = [];
      for (const targets of outputs) {
        if (!Array.isArray(targets)) continue;
        const kept = targets.filter(
          (target) =>
            !(isPlainObject(target) && typeof target.node === "string" && removed.has(target.node)),
        );
        keptOutputs.push(kept);
      }
      if (keptOutputs.some((targets) => Array.isArray(targets) && targets.length > 0)) {
        keptByType[type] = keptOutputs;
      }
    }
    if (Object.keys(keptByType).length > 0) pruned[source] = keptByType;
  }
  return pruned;
}

function normalizeAllowlist(allowlist: unknown): Set<string> {
  const hosts = new Set<string>();
  const entries = Array.isArray(allowlist) ? allowlist : typeof allowlist === "string" ? [allowlist] : [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "") continue;
    hosts.add(hostOf(entry));
  }
  hosts.delete("");
  return hosts;
}

function hostOf(value: string): string {
  const text = value.trim().toLowerCase();
  if (text.includes("://")) {
    try {
      return new URL(text).hostname.toLowerCase();
    } catch {
      return text;
    }
  }
  return text.split("/")[0]?.split(":")[0] ?? text;
}

function collectUrls(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value.trim())) out.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectUrls(entry, out);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) collectUrls(entry, out);
  }
}

async function postWebhook(
  fetchFn: FetchFn,
  url: string,
  secret: string | undefined,
  payload: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-webhook-secret"] = secret;
  const response = (await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload, secret }),
  })) as { status?: number; text?: () => Promise<string>; json?: () => Promise<unknown> };
  if (typeof response?.json === "function") return await response.json();
  if (typeof response?.text === "function") {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return response;
}

/** Best-effort trigger payload from a failing execution's run data. */
function extractTriggerPayload(execution: unknown): unknown {
  if (!isPlainObject(execution)) return undefined;
  const candidates = [
    (execution as Record<string, unknown>).triggerPayload,
    (execution as Record<string, unknown>).payload,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return candidate;
  }
  const runData = findRunData(execution);
  if (runData !== null) {
    for (const tasks of Object.values(runData)) {
      const list = Array.isArray(tasks) ? tasks : [];
      const task = list[0] as unknown;
      if (isPlainObject(task)) {
        const json = (task as Record<string, unknown>).json;
        if (json !== undefined) return json;
        const data = (task as Record<string, unknown>).data;
        if (data !== undefined) return data;
      }
    }
  }
  return undefined;
}

function findRunData(execution: Record<string, unknown>): Record<string, unknown> | null {
  if (isPlainObject(execution.runData)) return execution.runData;
  if (isPlainObject(execution.resultData) && isPlainObject(execution.resultData.runData)) {
    return execution.resultData.runData;
  }
  if (isPlainObject(execution.data)) {
    const data = execution.data;
    if (isPlainObject(data.resultData) && isPlainObject(data.resultData.runData)) {
      return data.resultData.runData;
    }
    if (isPlainObject(data.runData)) return data.runData;
  }
  return null;
}

/** Row collection for captured execution payloads (same shapes as verify). */
function collectSandboxRows(execution: unknown): unknown[] {
  if (execution === null || execution === undefined) return [];
  if (Array.isArray(execution)) return execution;
  if (!isPlainObject(execution)) return [];
  for (const key of ["rows", "data", "output", "result", "results", "items"] as const) {
    if (Array.isArray(execution[key])) return execution[key] as unknown[];
  }
  if (execution.runData !== undefined) {
    const rows = sandboxRunDataRows(execution.runData);
    if (rows !== null) return rows;
  }
  if (isPlainObject(execution.resultData) && execution.resultData.runData !== undefined) {
    const rows = sandboxRunDataRows(execution.resultData.runData);
    if (rows !== null) return rows;
  }
  if (isPlainObject(execution.data)) {
    const nested = collectSandboxRows(execution.data);
    if (nested.length > 0) return nested;
  }
  if (isPlainObject(execution.execution)) {
    const nested = collectSandboxRows(execution.execution);
    if (nested.length > 0) return nested;
  }
  return [];
}

function sandboxRunDataRows(runData: unknown): unknown[] | null {
  if (!isPlainObject(runData)) return null;
  const rows: unknown[] = [];
  let usable = false;
  for (const tasks of Object.values(runData)) {
    const list = Array.isArray(tasks) ? tasks : isPlainObject(tasks) ? [tasks] : null;
    if (list === null) continue;
    usable = true;
    for (const task of list) {
      if (isPlainObject(task) && Object.hasOwn(task, "json")) rows.push(task.json);
      else rows.push(task);
    }
  }
  return usable ? rows : null;
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

function describeValue(value: unknown): string {
  if (value instanceof Error && value.message !== "") return value.message;
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? typeof value : text.slice(0, 200);
  } catch {
    return typeof value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
