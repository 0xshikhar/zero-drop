/**
 * Small app preferences that settings.ts (core) has no field for: the active deployment and the posting
 * transport. Stored in localStorage under one key, every access inside try/catch; with no storage they live in
 * memory for the session. Never holds a secret.
 */
import { useSyncExternalStore } from "react";
import { getSettings, subscribeSettings, type Settings } from "@zerodrop/core";
import { DEFAULT_DEPLOYMENT_ID, defaultDeployment, findDeployment, type Deployment } from "./config";

export type TransportChoice = "direct" | "frame";
export type Prefs = { deploymentId: string; transport: TransportChoice };

const KEY = "zerodrop.prefs.v1";
const DEFAULTS: Prefs = { deploymentId: DEFAULT_DEPLOYMENT_ID, transport: "direct" };

function read(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<Prefs>;
      return {
        deploymentId: typeof o.deploymentId === "string" ? o.deploymentId : DEFAULTS.deploymentId,
        transport: o.transport === "frame" ? "frame" : "direct",
      };
    }
  } catch {
    // unreadable storage: defaults
  }
  return { ...DEFAULTS };
}

let current: Prefs = read();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function updatePrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
    // blocked storage: the in-memory value still holds for this session
  }
  for (const l of [...listeners]) l();
}

export function resetPrefs(): void {
  current = { ...DEFAULTS };
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // ignore
  }
  for (const l of [...listeners]) l();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active deployment: the stored choice if still usable, else the default. Undefined when config/ has none. */
export function activeDeployment(): Deployment | undefined {
  return findDeployment(current.deploymentId) ?? defaultDeployment();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}

// useSyncExternalStore needs a stable snapshot: core's getSettings() returns a fresh copy every call, so cache by version.
let settingsSnapshot: Settings = getSettings();
let settingsHooked = false;
const settingsListeners = new Set<() => void>();
function hookSettings() {
  if (settingsHooked) return;
  settingsHooked = true;
  subscribeSettings((s) => {
    settingsSnapshot = s;
    for (const l of [...settingsListeners]) l();
  });
}

hookSettings();

export function useSettings(): Settings {
  hookSettings();
  return useSyncExternalStore(
    (listener) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    () => settingsSnapshot,
  );
}

/** Current settings without a hook. Same cached copy the hook returns. */
export function currentSettings(): Settings {
  hookSettings();
  return settingsSnapshot;
}

/** The active deployment, re-rendering on change. */
export function useDeployment(): Deployment | undefined {
  const prefs = usePrefs();
  return findDeployment(prefs.deploymentId) ?? defaultDeployment();
}
