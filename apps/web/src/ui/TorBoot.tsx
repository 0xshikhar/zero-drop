import { retryAnon, useBootState, useNetworkPlan, useTraffic, ANON_CONFIGURED, DEFAULT_ANON_SPECIFIER } from "../lib/network";
import { toHref } from "../lib/router";

/**
 * Network route bar. Shows the plan (why a request goes direct or anonymous) and, when Anon-RPC is the route,
 * its boot state: idle, booting with step and percent, ready, or failed with Retry. Failure is never hidden and
 * never turns into a direct connection by itself.
 *
 * Security guarantee displayed to the user: when Anon-RPC is active, the circuit was established with the
 * official Ethereum Foundation Tor-JS specifier contract and no requests fell back to a direct connection.
 */
export function TorBoot() {
  const plan = useNetworkPlan();
  const boot = useBootState();
  const traffic = useTraffic();

  if (plan.effective === "direct") {
    const forced = plan.requested === "anon";
    return (
      <div className={`bootbar ${forced ? "neutral" : "warn-bar"}`} role="status">
        <strong>Network: direct.</strong> {plan.note}
        {forced && <span className="muted"> Anon-RPC is selected in Settings but is not used for a local chain.</span>}
        {traffic.total > 0 && (
          <span className="muted small"> · {traffic.total} request{traffic.total === 1 ? "" : "s"} ({traffic.direct} direct)</span>
        )}
      </div>
    );
  }

  if (boot.status === "booting") {
    return (
      <div className="bootbar neutral" role="status" aria-live="polite">
        <strong>Anon-RPC (Tor) connecting{boot.percent !== undefined ? ` ${boot.percent}%` : ""}.</strong>{" "}
        <span className="mono small">{boot.step}</span>
        <div className="progress" aria-hidden="true"><span style={{ width: `${boot.percent ?? 4}%` }} /></div>
        <span className="small muted">
          Using EF Tor-JS specifier{" "}
          <code className="mono">{DEFAULT_ANON_SPECIFIER.slice(0, 10)}…</code>.
          Requests wait until the circuit is ready; none go out directly.
        </span>
      </div>
    );
  }
  if (boot.status === "ready") {
    return (
      <div className="bootbar ok" role="status">
        <strong>Anon-RPC ready.</strong>{" "}
        <span className="muted">
          Tor circuit established in {(boot.bootMs / 1000).toFixed(1)} s via EF specifier{" "}
          <code className="mono">{DEFAULT_ANON_SPECIFIER.slice(0, 10)}…</code>.
          {" "}{traffic.anonymous > 0
            ? `${traffic.anonymous}/${traffic.total} requests anonymous, ${traffic.direct} direct (bootstrap only).`
            : "Requests routed anonymously."}
        </span>
      </div>
    );
  }
  if (boot.status === "failed") {
    return (
      <div className="bootbar bad" role="alert">
        <strong>
          {boot.code === "NOT_CONFIGURED" ? "Anon-RPC is not configured." : `Anon-RPC failed: ${boot.reason}.`}
        </strong>{" "}
        <span>
          Requests are NOT sent and there is no fallback to a direct connection.{" "}
          {boot.code === "NOT_CONFIGURED"
            ? `This build has no specifier address or bootstrap RPC (VITE_ANON_SPECIFIER, VITE_ANON_BOOTSTRAP_RPC). `
            : ""}
          {ANON_CONFIGURED
            ? `EF specifier: ${DEFAULT_ANON_SPECIFIER.slice(0, 10)}…. `
            : ""}
          Choose "direct" in Settings to continue (that exposes your IP address).
        </span>
        <div className="actions tight">
          <button className="secondary small-btn" onClick={retryAnon}>Retry</button>
          <a className="brass-link small" href={toHref("/settings")}>Open settings</a>
        </div>
      </div>
    );
  }
  return (
    <div className="bootbar neutral" role="status">
      <strong>Anon-RPC: ready to start.</strong>{" "}
      <span className="muted">
        Uses EF Tor-JS specifier <code className="mono">{DEFAULT_ANON_SPECIFIER.slice(0, 10)}…</code>.
        Starts on first request; no requests go out directly.
      </span>
    </div>
  );
}
