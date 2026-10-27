/**
 * Pinned contract (issue #6): HTTP client for a real n8n instance. Reads and
 * patches workflow JSON, fetches failed-execution run data, activates and
 * deactivates workflows, and probes whether the deployment exposes the manual
 * run endpoint (which decides the sandbox's primary vs fallback verification
 * path). Configuration is constructor-injected — this module never touches
 * `process.env`; wiring reads `Settings.n8nBaseUrl`/`n8nApiKey` (the
 * `N8N_BASE_URL`/`N8N_API_KEY` env vars). Uses the global `fetch` plus
 * `AbortSignal.timeout`, so no HTTP framework or new dependency is involved.
 */

/** Workflow payload, passed through verbatim: JSON in, JSON out. */
export type WorkflowJson = Record<string, unknown>;

/** Execution payload (including `runData` on fetched executions), verbatim. */
export type ExecutionJson = Record<string, unknown>;

export interface N8nClientConfig {
  /** n8n instance root, e.g. "https://n8n.techa.pro" — the client appends `/api/v1`. */
  baseUrl: string;
  /** Sent verbatim as the `X-N8N-API-KEY` header on every request. */
  apiKey: string;
  /** Per-request deadline in milliseconds; must be a positive finite number. */
  timeoutMs?: number;
}

/**
 * Thrown when n8n answers 404 for an unknown workflow or execution id, so
 * consumers can distinguish "gone" from transport or server failures.
 */
export class N8nNotFoundError extends Error {
  readonly resource: "workflow" | "execution";
  readonly id: string;

  constructor(resource: "workflow" | "execution", id: string, method: string, path: string) {
    super(`n8n: ${resource} "${id}" not found (404 at ${method} ${path})`);
    this.name = "N8nNotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

/** n8n public API base path appended to the configured instance root. */
const API_BASE = "/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

interface SendResult {
  status: number;
  bodyText: string;
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: N8nClientConfig) {
    if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
      throw new TypeError("n8n: baseUrl is required");
    }
    if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
      throw new TypeError("n8n: apiKey is required");
    }
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
      throw new TypeError("n8n: timeoutMs must be a positive finite number");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getWorkflow(id: string): Promise<WorkflowJson> {
    return this.requestRecord("workflow", id, "GET", `${API_BASE}/workflows/${id}`);
  }

  async createWorkflow(json: WorkflowJson): Promise<WorkflowJson> {
    return this.requestRecord("workflow", "", "POST", `${API_BASE}/workflows`, json);
  }

  async updateWorkflow(id: string, json: WorkflowJson): Promise<WorkflowJson> {
    return this.requestRecord("workflow", id, "PUT", `${API_BASE}/workflows/${id}`, json);
  }

  async deleteWorkflow(id: string): Promise<WorkflowJson> {
    // n8n returns the deleted workflow object in the response body.
    return this.requestRecord("workflow", id, "DELETE", `${API_BASE}/workflows/${id}`);
  }

  async activateWorkflow(id: string): Promise<WorkflowJson> {
    return this.requestRecord("workflow", id, "POST", `${API_BASE}/workflows/${id}/activate`, {});
  }

  async deactivateWorkflow(id: string): Promise<WorkflowJson> {
    return this.requestRecord("workflow", id, "POST", `${API_BASE}/workflows/${id}/deactivate`, {});
  }

  async listExecutions(): Promise<unknown> {
    const path = `${API_BASE}/executions`;
    const response = await this.send("GET", path);
    if (response.status < 200 || response.status > 299) {
      throw new Error(`n8n: GET ${path} returned ${response.status}: ${truncate(response.bodyText)}`);
    }
    return parseJsonBody(response, "GET", path);
  }

  async listWorkflows(): Promise<WorkflowJson[]> {
    const path = `${API_BASE}/workflows`;
    const response = await this.send("GET", path);
    if (response.status < 200 || response.status > 299) {
      throw new Error(
        `n8n: GET ${path} returned ${response.status}: ${truncate(response.bodyText)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new Error(`n8n: GET ${path} returned non-JSON body: ${truncate(response.bodyText)}`, { cause });
    }
    if (Array.isArray(parsed)) return parsed.filter((item): item is WorkflowJson => isRecord(item));
    if (isRecord(parsed)) {
      const data = parsed["data"];
      if (Array.isArray(data)) return data.filter((item): item is WorkflowJson => isRecord(item));
    }
    return [];
  }

  async getExecution(id: string): Promise<ExecutionJson> {
    // includeData=true is what makes n8n return the execution's runData payload.
    return this.requestRecord("execution", id, "GET", `${API_BASE}/executions/${id}?includeData=true`);
  }

  /**
   * Probe whether this n8n deployment exposes the manual run endpoint for a
   * workflow. `true` means any non-404 answer: the route is registered (on a
   * real deployment a positive probe may already trigger one empty run —
   * acceptable, since the sandbox runs that workflow deliberately right
   * after). `false` means 404, i.e. the route does not exist here and the
   * sandbox must take its fallback path. Never parses the body.
   */
  async probeRunEndpoint(workflowId: string): Promise<boolean> {
    const path = `${API_BASE}/workflows/${workflowId}/run`;
    const response = await this.send("POST", path, {});
    return response.status !== 404;
  }

  /**
   * Single transport helper: builds the URL, sets the pinned headers, applies
   * the deadline, and wraps every low-level failure (network error, timeout,
   * connection refused, truncated body) in a contextual `Error` with
   * `{ cause }` so calling code only ever sees a regular rejected promise —
   * no DOMException or TypeError leaks to the surface.
   */
  private async send(method: string, path: string, body?: WorkflowJson): Promise<SendResult> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "x-n8n-api-key": this.apiKey,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const bodyText = await response.text();
      return { status: response.status, bodyText };
    } catch (cause) {
      throw new Error(`n8n: ${method} ${path} failed (${describe(cause)})`, { cause });
    }
  }

  /**
   * `send` + status discipline + JSON parsing: 404 becomes
   * `N8nNotFoundError`, any other non-2xx becomes a plain `Error` carrying
   * the status and the first 200 body characters, 2xx bodies are parsed and
   * returned as records.
   */
  private async requestRecord(
    resource: "workflow" | "execution",
    id: string,
    method: string,
    path: string,
    body?: WorkflowJson,
  ): Promise<Record<string, unknown>> {
    const response = await this.send(method, path, body);
    if (response.status === 404) throw new N8nNotFoundError(resource, id, method, path);
    if (response.status < 200 || response.status > 299) {
      throw new Error(
        `n8n: ${method} ${path} returned ${response.status}: ${truncate(response.bodyText)}`,
      );
    }
    return parseJsonBody(response, method, path);
  }
}

function parseJsonBody(response: SendResult, method: string, path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(response.bodyText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`body is ${describe(parsed)}, expected an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`n8n: ${method} ${path} returned non-JSON body: ${truncate(response.bodyText)}`, { cause });
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 200);
}
