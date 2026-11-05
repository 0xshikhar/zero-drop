import { useEffect, useState, type ReactNode } from "react";
import { network, statusLabels } from "@zerodrop/core";
import { LOCAL } from "../lib/config";
import type { Route } from "../lib/router";

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const labels = statusLabels();
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="#/drop">ZeroDrop<span>/</span>disclosures</a>
        <nav className="nav" aria-label="Main">
          <NavLink href="#/drop" active={route.name === "drop"}>Post</NavLink>
          <NavLink href="#/groups" active={route.name === "groups"}>Groups</NavLink>
          <NavLink href="#/settings" active={route.name === "settings"}>Settings</NavLink>
          <NavLink href="#/about" active={route.name === "about"}>About</NavLink>
        </nav>
      </header>

      <div className="badges" aria-label="What this build does">
        <span className="badge badge-neutral" title="Proof system in use">{labels.proof}</span>
        <span className="badge badge-warning" title="How the posting transaction leaves the browser">{labels.transport}</span>
        <span className="badge badge-warning" title="Network privacy">{labels.anonNetwork}</span>
        <span className="badge badge-neutral mono">Chain {LOCAL.chainId} · local anvil</span>
      </div>

      <main>{children}</main>

      <footer>
        <span>ZeroDrop · prototype, not for sensitive disclosures</span>
        <TrafficMeter />
      </footer>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return <a className={active ? "navlink active" : "navlink"} href={href} aria-current={active ? "page" : undefined}>{children}</a>;
}

/** Counts requests this session. Every request is direct: Anon-RPC is not integrated. */
function TrafficMeter() {
  const [summary, setSummary] = useState(network.summary());
  useEffect(() => {
    const timer = window.setInterval(() => setSummary(network.summary()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="meter mono" title="Requests leaving this browser in this session">
      {summary.total} requests · {summary.direct} direct · {summary.anonymous} anonymous
    </span>
  );
}

export function Tick({ children }: { children?: ReactNode }) {
  return <span className="verified"><span aria-hidden="true">✓</span> {children ?? "Verified"}</span>;
}

export function short(hex: string, head = 10, tail = 6): string {
  return hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}
