import { afterEach, describe, expect, it } from "vitest";
import { runFix } from "../src/cli/fix.js";
import { loadSettings } from "../src/config/settings.js";
import { MockLLM } from "../src/llm/mock.js";
import { N8nNotFoundError } from "../src/n8n/client.js";
import { openStore, type Store } from "../src/store/store.js";

const opened: Store[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // Close is best-effort; the assertions already ran.
    }
  }
});

function track(store: Store): Store {
  opened.push(store);
  return store;
}

function seedWorkflow(): Record<string, unknown> {
  return {
    id: "wf-1",
    name: "test-flow",
    nodes: [
      { name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
      { name: "HttpRequest", type: "n8n-nodes-base.httpRequest", typeVersion: 1, position: [200, 0], parameters: { url: "https://example.com/api" } },
      { name: "Set", type: "n8n-nodes-base.set", typeVersion: 1, position: [400, 0], parameters: { value: "={{ $json.old }}" } },
    ],
    connections: {
      Start: { main: [[{ node: "HttpRequest", type: "main", index: 0 }]] },
      HttpRequest: { main: [[{ node: "Set", type: "main", index: 0 }]] },
    },
  };
}

function seedRunPayload(workflowId: string): Record<string, unknown> {
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

/** Capture console.error (stderr) lines for the duration of `run`. */
async function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.error = original;
  }
}

/** Silence console.log (stdout report) for the duration of `run`. */
async function silenceStdout<T>(run: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = original;
  }
}

describe("kintsugi fix: unknown execution", () => {
  it("exits 1 with `not found` on stderr", async () => {
    const store = track(openStore(":memory:"));
    const client = {
      getExecution: async (id: string): Promise<unknown> => {
        throw new N8nNotFoundError("execution", id, "GET", `/api/v1/executions/${id}?includeData=true`);
      },
    };
    const { value, lines } = await captureStderr(() =>
      silenceStdout(() => runFix("nope", { store, client, settings: loadSettings() })),
    );
    expect(value.exitCode).toBe(1);
    expect(lines.join("\n")).toMatch(/not found/i);
  });
});

describe("kintsugi fix: schema-drift inline turn", () => {
  it("exits 0 with a status word, a nodes.* leaf path, and an llm_traces row", async () => {
    const store = track(openStore(":memory:"));
    const workflow = seedWorkflow();
    const workflows = new Map<string, unknown>([
      ["wf-1", JSON.parse(JSON.stringify(workflow)) as unknown],
    ]);
    const llm = new MockLLM({ MOCK_LLM_SCENARIO: "schema-drift" } as NodeJS.ProcessEnv);
    const payload = seedRunPayload("wf-1");
    const client = { getExecution: async (): Promise<unknown> => payload };
    const { exitCode, report } = await silenceStdout(() =>
      runFix("e-fix", {
        store,
        settings: loadSettings(),
        llm,
        client,
        workflows,
        verifyFn: async () => ({ ok: true, failures: [] }),
      }),
    );
    expect(exitCode).toBe(0);
    expect(report).toMatch(/auto-promoted|awaiting-approval/);
    expect(report).toMatch(/nodes\./);
    expect(store.listTraces("e-fix").length).toBeGreaterThanOrEqual(1);
  });
});
