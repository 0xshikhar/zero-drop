import type { TimelineStep } from "../lib/post";

const MARK: Record<TimelineStep["status"], string> = { done: "✓", error: "!", active: "…", pending: "·", skipped: "–", cancelled: "×" };

/** The posting timeline. Every mark reflects a state the pipeline actually reached. */
export function TxTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="timeline" aria-label="Posting timeline">
      {steps.map((s) => (
        <li key={s.id} className={`tl ${s.status}`} data-step={s.id} data-status={s.status}>
          <span className="tl-mark" aria-hidden="true">{MARK[s.status]}</span>
          <div>
            <strong>{s.label}</strong>
            <span className="tl-status small muted"> · {s.status === "skipped" ? "skipped" : s.status}</span>
            {s.detail && <p className="small mono muted">{s.detail}</p>}
            {s.sidecars && s.sidecars.length > 0 && (
              <ul className="sidecars">
                {s.sidecars.map((c) => (
                  <li key={c.url}>
                    <span className="mono small">{c.url}</span>
                    <span className={c.submit === "accepted" ? "verified small" : c.submit === "rejected" ? "error-text small" : "muted small"}>
                      {c.submit === "accepted" ? "accepted" : c.submit === "rejected" ? `rejected${c.error ? `: ${c.error}` : ""}` : "sending…"}
                    </span>
                    {c.status && <span className="mono small muted">status {c.status}</span>}
                    {!c.status && c.error && c.submit === "accepted" && <span className="small warning-text">{c.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
