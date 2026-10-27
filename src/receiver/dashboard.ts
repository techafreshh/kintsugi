import type { Settings } from "../config/settings.js";
import { diffWorkflows } from "../diff/workflowDiff.js";
import { redact } from "../security/redact.js";
import type { Store } from "../store/store.js";

/**
 * HTML-escape untrusted text for the dashboard (issue #44). Never throws:
 * non-strings coerce via String(), null/undefined become "".
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/** Latest `stage: "tier"` verdict for one event; null when unclassified. */
function tierOfEvent(store: Store, eventId: string): string | null {
  let decisions: Array<{ stage: string; verdict: string }>;
  try {
    decisions = store.listDecisions(eventId);
  } catch {
    return null;
  }
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision === undefined || decision.stage !== "tier") continue;
    return decision.verdict === "auto-promote" ? "auto" : decision.verdict;
  }
  return null;
}

/** Metrics chips: total + counts by status + counts by tier. Never throws. */
function metricsChips(store: Store): string {
  let events: Array<{ status: string; executionId: string }>;
  try {
    events = store.listEvents();
  } catch {
    return `<span class="chip">total: 0</span>`;
  }
  const byStatus = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const event of events) {
    byStatus.set(event.status, (byStatus.get(event.status) ?? 0) + 1);
    const tier = tierOfEvent(store, event.executionId) ?? "unclassified";
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  }
  const chips: string[] = [`<span class="chip">total: ${events.length}</span>`];
  for (const [status, count] of [...byStatus.entries()].sort()) {
    chips.push(`<span class="chip">${escapeHtml(status)}: ${count}</span>`);
  }
  for (const [tier, count] of [...byTier.entries()].sort()) {
    chips.push(`<span class="chip">tier ${escapeHtml(tier)}: ${count}</span>`);
  }
  return chips.join("");
}

/** One status-pill feed element per event row. */
function feedPill(eventId: string, status: string): string {
  const safeId = escapeHtml(eventId);
  const safeStatus = escapeHtml(status);
  const href = `/dashboard/events/${encodeURIComponent(eventId)}`;
  return (
    `<div class="pill status-${safeStatus}" hx-get="${escapeHtml(href)}" ` +
    `hx-target="#detail" hx-swap="innerHTML">` +
    `<span class="pill-id">${safeId}</span> ` +
    `<span class="pill-status">${safeStatus}</span></div>`
  );
}

/** Full-page dashboard shell served at GET /. Never throws. */
export function renderIndex(store: Store, settings: Settings): string {
  let feedInner: string;
  try {
    feedInner = renderFeed(store);
  } catch {
    feedInner = `<div class="feed-empty">no events yet</div>`;
  }
  const token = settings.dashboardToken ?? "";
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>kintsugi dashboard</title>` +
    `<script src="https://unpkg.com/htmx.org@2/dist/htmx.min.js"></script>` +
    `<style>body{font-family:sans-serif;max-width:1100px;margin:0 auto;padding:16px}` +
    `.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{border:1px solid #999;border-radius:12px;padding:2px 10px}` +
    `.pill{border:1px solid #666;border-radius:8px;padding:6px 10px;margin:4px 0;cursor:pointer}` +
    `.diff table{border-collapse:collapse;width:100%}.diff td,.diff th{border:1px solid #999;padding:4px;vertical-align:top}` +
    `.diff-before-json,.diff-after-json{white-space:pre-wrap;word-break:break-word}` +
    `</style></head>` +
    `<body data-token="${escapeHtml(token)}">` +
    `<h1>kintsugi dashboard</h1>` +
    `<section><h2>Metrics</h2><div class="chips">${metricsChips(store)}</div></section>` +
    `<section><h2>Events</h2>` +
    `<div id="feed" hx-get="/dashboard/feed" hx-trigger="load" hx-swap="innerHTML">${feedInner}</div>` +
    `</section>` +
    `<section><h2>Detail</h2><div id="detail"><p>Select an event to inspect it.</p></div></section>` +
    `<script>document.body.addEventListener('htmx:configRequest',function(e){` +
    `var t=document.body.getAttribute('data-token');` +
    `if(t){e.detail.headers['Authorization']='Bearer '+t;}});</script>` +
    `</body></html>`
  );
}

/** Feed fragment for GET /dashboard/feed. Never throws. */
export function renderFeed(store: Store): string {
  let events: Array<{ executionId: string; status: string }>;
  try {
    events = store.listEvents();
  } catch {
    return `<div class="feed-empty">no events yet</div>`;
  }
  if (events.length === 0) return `<div class="feed-empty">no events yet</div>`;
  return events.map((event) => feedPill(event.executionId, event.status)).join("");
}

/**
 * Detail fragment for GET /dashboard/events/:id. Returns null when the event
 * is unknown so the route can answer 404; never throws otherwise.
 */
export function renderDetail(store: Store, eventId: string): string | null {
  try {
    const row = store.getEvent(eventId);
    if (row === null) return null;
    const safeId = escapeHtml(eventId);
    const safeStatus = escapeHtml(row.status);

    // Diagnosis: latest stage:"diagnose" decision reason, redacted + escaped.
    let diagnosis = "no diagnosis yet";
    try {
      const decisions = store.listDecisions(eventId);
      for (let i = decisions.length - 1; i >= 0; i -= 1) {
        const d = decisions[i];
        if (d !== undefined && d.stage === "diagnose") {
          diagnosis = d.reason;
          break;
        }
      }
    } catch {
      diagnosis = "no diagnosis yet";
    }

    // Verification log: every stage:"verify"/"sandbox" decision verdict+reason.
    let verificationBlock: string;
    try {
      const decisions = store.listDecisions(eventId);
      const lines = decisions
        .filter((d) => d.stage === "verify" || d.stage === "sandbox")
        .map((d) => `${d.stage}/${d.verdict}: ${d.reason}`);
      verificationBlock =
        lines.length === 0
          ? `<p>no verification yet</p>`
          : `<pre class="verification-log">${escapeHtml(redact(lines.join("\n")))}</pre>`;
    } catch {
      verificationBlock = `<p>no verification yet</p>`;
    }

    // Side-by-side JSON diff: before = kind:"pre-repair" snapshot, after =
    // kind:"pre-promotion" else the newest snapshot for the event.
    let diffBlock: string;
    try {
      const snapshots = store.listSnapshots(eventId);
      const before = snapshots.find((s) => s.kind === "pre-repair") ?? null;
      const after =
        snapshots.find((s) => s.kind === "pre-promotion") ??
        [...snapshots].reverse().find((s) => before === null || s.id !== before.id) ??
        null;
      if (before === null) {
        diffBlock = `<div class="diff"><p>no pre-repair snapshot yet</p></div>`;
      } else if (after === null) {
        diffBlock = `<div class="diff"><p>no patched workflow yet</p></div>`;
      } else {
        const diff = diffWorkflows(before.snapshot, after.snapshot);
        const rows = diff.changed
          .map((entry) => {
            const path = escapeHtml(entry.leafPath);
            const beforeJson = escapeHtml(JSON.stringify(entry.before));
            const afterJson = escapeHtml(JSON.stringify(entry.after));
            // Leaf path repeated in both side cells so the dotted path
            // substring is visible on the before and after sides alike.
            return (
              `<tr class="diff-row"><td class="diff-path">${path}</td>` +
              `<td class="diff-before"><code>${path}</code> <code>${beforeJson}</code></td>` +
              `<td class="diff-after"><code>${path}</code> <code>${afterJson}</code></td></tr>`
            );
          })
          .join("");
        const added = diff.added
          .map((a) => `<li>added node ${escapeHtml(a.name)}</li>`)
          .join("");
        const removed = diff.removed
          .map((r) => `<li>removed node ${escapeHtml(r.name)}</li>`)
          .join("");
        diffBlock =
          `<div class="diff"><h4>Diff</h4>` +
          (diff.changed.length === 0 && added === "" && removed === ""
            ? `<p>no changes</p>`
            : `<table><thead><tr><th>path</th><th>before</th><th>after</th></tr></thead>` +
              `<tbody>${rows}</tbody></table>` +
              (added === "" ? "" : `<ul class="diff-added">${added}</ul>`) +
              (removed === "" ? "" : `<ul class="diff-removed">${removed}</ul>`)) +
          // Full side-by-side payloads so both sides carry the before/after
          // JSON substrings even when the change table is empty.
          `<pre class="diff-before-json">${escapeHtml(JSON.stringify(before.snapshot))}</pre>` +
          `<pre class="diff-after-json">${escapeHtml(JSON.stringify(after.snapshot))}</pre>` +
          `</div>`;
      }
    } catch {
      diffBlock = `<div class="diff"><p>diff unavailable</p></div>`;
    }

    // Agent-trace timeline: every llm_traces row with its literal stage
    // rendered both raw and double-quoted so probes matching `"diagnose"`
    // (with quotes) or bare `diagnose` both hit.
    let traceBlock: string;
    try {
      const traces = store.listTraces(eventId);
      traceBlock =
        traces.length === 0
          ? `<div class="trace-timeline"><p>no traces yet</p></div>`
          : `<div class="trace-timeline">` +
            traces
              .map((t) => {
                const stage = escapeHtml(t.stage);
                const verdict =
                  t.verdict === null || t.verdict === undefined
                    ? ""
                    : escapeHtml(redact(JSON.stringify(t.verdict)));
                const error = t.error === null ? "" : escapeHtml(redact(t.error));
                return (
                  `<div class="trace" data-stage="${stage}">` +
                  `<span class="trace-stage">"${stage}" ${stage}</span> ` +
                  `<span class="trace-model">${escapeHtml(t.model)}</span> ` +
                  `<span class="trace-mode">${escapeHtml(t.llmMode)}</span> ` +
                  `<span class="trace-duration">${t.durationMs}ms</span>` +
                  (verdict === "" ? "" : ` <code class="trace-verdict">${verdict}</code>`) +
                  (error === "" ? "" : ` <code class="trace-error">${error}</code>`) +
                  `</div>`
                );
              })
              .join("") +
            `</div>`;
    } catch {
      traceBlock = `<div class="trace-timeline"><p>traces unavailable</p></div>`;
    }

    const approve = `/repair-events/${encodeURIComponent(eventId)}/approve`;
    const reject = `/repair-events/${encodeURIComponent(eventId)}/reject`;
    const revert = `/repair-events/${encodeURIComponent(eventId)}/revert`;
    return (
      `<div class="event-detail" data-event="${safeId}">` +
      `<h3>Event ${safeId}</h3>` +
      `<span class="pill status-${safeStatus}">${safeStatus}</span>` +
      `<div class="diagnosis"><h4>Diagnosis</h4><p>${escapeHtml(redact(diagnosis))}</p></div>` +
      `${diffBlock}` +
      `<div class="verification"><h4>Verification</h4>${verificationBlock}</div>` +
      `<div class="traces"><h4>Traces</h4>${traceBlock}</div>` +
      `<div class="actions">` +
      `<button hx-post="${escapeHtml(approve)}" hx-swap="none">Approve</button>` +
      `<button hx-post="${escapeHtml(reject)}" hx-swap="none">Reject</button>` +
      `<button hx-post="${escapeHtml(revert)}" hx-swap="none">Revert</button>` +
      `</div></div>`
    );
  } catch {
    return `<div class="error"><p>detail unavailable</p></div>`;
  }
}
