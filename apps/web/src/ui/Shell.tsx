import type { ReactNode } from "react";
import { setDeploymentInfo, statusLabels } from "@zerodrop/core";
import { useDeployment, usePrefs, useSettings } from "../lib/prefs";
import { useBootState, useNetworkPlan, useTraffic } from "../lib/network";
import { toHref, type Route } from "../lib/router";
import { frameAvailability } from "../lib/post";
import { TorBoot } from "./TorBoot";

export { Tick, MockMark } from "./common";
export { short } from "../lib/util";

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const deployment = useDeployment();
  const prefs = usePrefs();
  const settings = useSettings();
  const plan = useNetworkPlan();
  const boot = useBootState();
  // Keep the core labels in step with the deployment the user picked (idempotent).
  if (deployment) setDeploymentInfo({ verifierKind: deployment.verifierKind, directRecordEnabled: deployment.directRecordEnabled });
  // A chosen frame transport that cannot run is shown as direct would be a lie; show what will actually happen.
  const frameOk = frameAvailability(deployment, settings).ok;
  const transport = prefs.transport === "frame" && frameOk ? "frame" : "direct";
  const labels = statusLabels({ transport });
  void boot; // re-render on boot-state changes so the network label stays current

  const anonTone = plan.effective === "direct" ? "badge-warning" : boot.status === "ready" ? "badge-neutral" : "badge-error";

  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href={toHref("/")}>ZeroDrop</a>
        <nav className="nav" aria-label="Main">
          <NavLink href={toHref("/")} active={route.name === "home"}>Home</NavLink>
          <NavLink href={toHref("/app")} active={route.name === "drop"}>App</NavLink>
          <NavLink href={toHref("/d/")} active={route.name === "reader"}>Read</NavLink>
          <NavLink href={toHref("/groups")} active={route.name === "groups"}>Groups</NavLink>
          <NavLink href={toHref("/settings")} active={route.name === "settings"}>Settings</NavLink>
          <NavLink href={toHref("/support")} active={route.name === "support"}>Support</NavLink>
          <NavLink href={toHref("/about")} active={route.name === "about"}>About</NavLink>
        </nav>
      </header>

      <div className="badges" aria-label="What this build does">
        <span className={`badge ${deployment?.verifierKind === "mock" ? "badge-warning" : "badge-neutral"}`} title="Proof system of the active deployment">{labels.proof}</span>
        <span className="badge badge-warning" title="How the posting transaction leaves the browser">{labels.transport}</span>
        <span className={`badge ${anonTone}`} title="Network privacy">{labels.anonNetwork}</span>
        <span className="badge badge-neutral mono">{deployment ? `Chain ${deployment.chainId} · ${deployment.label}` : "No deployment"}</span>
      </div>

      <TorBoot />

      <main>{children}</main>

      <footer>
        <span>ZeroDrop · <a className="brass-link" href={toHref("/about")}>Verifiable Build (CID: bafk…7hq)</a> · prototype</span>
        <TrafficMeter />
      </footer>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return <a className={active ? "navlink active" : "navlink"} href={href} aria-current={active ? "page" : undefined}>{children}</a>;
}

/** Counts requests this session: N/N anonymous. Direct requests are named, not hidden. */
function TrafficMeter() {
  const s = useTraffic();
  return (
    <span className="meter mono" title="Requests leaving this browser in this session, and how many were handed to the anonymous route">
      {s.anonymous}/{s.total} requests anonymous · {s.direct} direct
    </span>
  );
}
