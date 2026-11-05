/**
 * Network startup. Decides, from the settings and the active deployment, whether requests go through Anon-RPC or
 * directly, applies it with configureNetwork, and exposes the plan and boot state to the UI.
 *
 * Rules:
 * - A local development chain (every RPC on 127.0.0.1 / localhost) is ALWAYS routed directly, and the UI says so.
 *   Tor cannot reach loopback, and there is nothing to hide from your own machine.
 * - Otherwise networkMode "anon" uses Anon-RPC. This repo carries no Anon-RPC configuration (no specifier
 *   address, no bootstrap RPC) unless VITE_ANON_SPECIFIER and VITE_ANON_BOOTSTRAP_RPC are set at build time, so
 *   by default the boot ends in NotConfigured and every request is rejected. There is no silent fallback to direct.
 * - The user can choose "direct" in Settings; the UI then labels the route "Not routed (direct)".
 */
import { useSyncExternalStore } from "react";
import { AnonRpcTransport, configureNetwork, network, subscribeSettings, type BootState, type Settings, type TrafficSummary } from "@zerodrop/core";
import { isLoopbackUrl, type Deployment } from "./config";
import { activeDeployment, currentSettings, subscribePrefs } from "./prefs";

export type NetworkPlan = {
  /** What the user asked for in Settings. */
  requested: "anon" | "direct";
  /** What the app actually uses. */
  effective: "anon" | "direct";
  /** Why it differs from the request, or why direct is in use. */
  note?: string;
};

export const LOCAL_CHAIN_NOTE = "local chain: not routed through Tor.";

/** The RPC URLs the app reads and writes through: the user's list if any, else the deployment's. */
export function effectiveRpcUrls(settings: Settings, deployment: Deployment | undefined): string[] {
  return settings.rpcUrls.length > 0 ? settings.rpcUrls : (deployment?.rpcUrls ?? []);
}

export function planNetwork(settings: Settings, deployment: Deployment | undefined): NetworkPlan {
  const requested = settings.networkMode;
  const rpcs = effectiveRpcUrls(settings, deployment);
  const local = rpcs.length > 0 && rpcs.every(isLoopbackUrl);
  if (local) return { requested, effective: "direct", note: LOCAL_CHAIN_NOTE };
  if (requested === "direct") return { requested, effective: "direct", note: "Direct mode chosen in Settings: every endpoint sees this machine's IP address." };
  return { requested, effective: "anon" };
}

const env = import.meta.env as Record<string, string | undefined>;

/** One transport the app owns, so Retry can reach it. Configured from build-time env, else unconfigured on purpose. */
const anon = new AnonRpcTransport({
  ...(env.VITE_ANON_SPECIFIER ? { address: env.VITE_ANON_SPECIFIER } : {}),
  ...(env.VITE_ANON_BOOTSTRAP_RPC ? { bootstrapRpcUrl: env.VITE_ANON_BOOTSTRAP_RPC } : {}),
});

export const ANON_CONFIGURED = Boolean(env.VITE_ANON_SPECIFIER && env.VITE_ANON_BOOTSTRAP_RPC);

let applied: "anon" | "direct" | undefined;

function apply(): void {
  const plan = planNetwork(currentSettings(), activeDeployment());
  if (plan.effective !== applied) {
    applied = plan.effective;
    if (plan.effective === "anon") {
      configureNetwork({ mode: "anon", anon });
      void network.boot().catch(() => {
        // the failure is in network.bootState; every request rejects until Retry
      });
    } else {
      configureNetwork({ mode: "direct" });
    }
  }
  notify();
}

const planListeners = new Set<() => void>();
let planSnapshot: NetworkPlan = planNetwork(currentSettings(), activeDeployment());
function notify() {
  const next = planNetwork(currentSettings(), activeDeployment());
  if (next.effective !== planSnapshot.effective || next.requested !== planSnapshot.requested || next.note !== planSnapshot.note) {
    planSnapshot = next;
  }
  for (const l of [...planListeners]) l();
}

let started = false;
/** Call once at startup. Applies the plan and keeps it in step with settings and the deployment choice. */
export function startNetwork(): void {
  if (started) return;
  started = true;
  apply();
  subscribeSettings(() => apply());
  subscribePrefs(() => apply());
}

/** Boots Anon-RPC again after a failure. */
export function retryAnon(): void {
  void anon.retry().catch(() => {
    // reflected in bootState
  });
}

export function useNetworkPlan(): NetworkPlan {
  return useSyncExternalStore(
    (l) => {
      planListeners.add(l);
      return () => planListeners.delete(l);
    },
    () => planSnapshot,
  );
}

const IDLE: BootState = { status: "idle" };
export function useBootState(): BootState {
  return useSyncExternalStore(
    (l) => network.subscribe(() => l()),
    () => {
      const state = network.bootState;
      return state.status === "idle" ? IDLE : state;
    },
  );
}

/** Whether requests can leave right now, and if not, why. Direct is always ready. */
export function networkGate(plan: NetworkPlan, boot: BootState): { ok: boolean; message?: string } {
  if (plan.effective === "direct") return { ok: true };
  if (boot.status === "ready") return { ok: true };
  if (boot.status === "failed") {
    return {
      ok: false,
      message:
        boot.code === "NOT_CONFIGURED"
          ? `Anon-RPC is not configured in this build (no specifier address or bootstrap RPC). Requests are not sent and there is no fallback to a direct connection. Choose "direct" in Settings to continue, which exposes your IP address.`
          : `Anon-RPC failed: ${boot.reason}. Requests are not sent. Retry, or choose "direct" in Settings (which exposes your IP address).`,
    };
  }
  return { ok: false, message: "Anon-RPC is still starting. Requests wait until it is ready." };
}

export function useTraffic(): TrafficSummary {
  const snapshot = useSyncExternalStore(
    (l) => {
      const timer = window.setInterval(l, 1000);
      return () => window.clearInterval(timer);
    },
    () => {
      const s = network.summary();
      return `${s.total}/${s.anonymous}/${s.direct}`;
    },
  );
  const [total, anonymous, direct] = snapshot.split("/").map(Number) as [number, number, number];
  return { total, anonymous, direct };
}
