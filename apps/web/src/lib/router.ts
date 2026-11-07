import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "drop" }
  | { name: "reader"; ref: string }
  | { name: "groups" }
  | { name: "settings" }
  | { name: "about" };

/**
 * Detects whether the app should run in hash routing mode (#/...) or clean pathname mode (/...).
 *
 * Hash mode is activated automatically when:
 * 1. Running from local filesystem (`file://`) where pathname rewrites don't exist.
 * 2. Running inside an IPFS/IPNS gateway subpath (e.g. `/ipfs/<CID>/` or `/ipns/<name>/`).
 *
 * Clean HTML5 pathname mode is activated when:
 * Running on a hosted web origin (`http:` or `https:`) at root (e.g. `http://localhost:5173`, `https://zerodrop.org`).
 */
export function isHashRouting(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return true;
  const path = window.location.pathname;
  if (path.startsWith("/ipfs/") || path.startsWith("/ipns/")) return true;
  return false;
}

/**
 * Returns the active internal route path, normalized without leading hashes or gateway prefixes.
 */
export function getCurrentPath(): string {
  if (typeof window === "undefined") return "/";

  // If in hash mode (or if an explicit hash route exists):
  if (isHashRouting() || window.location.hash.startsWith("#/")) {
    const fromHash = window.location.hash.replace(/^#/, "");
    if (fromHash) {
      // If we are on a hosted domain with clean path routing, seamlessly upgrade the hash to a clean path
      if (!isHashRouting() && window.history?.replaceState) {
        const cleanTarget = fromHash.startsWith("/") ? fromHash : `/${fromHash}`;
        window.history.replaceState(null, "", cleanTarget);
        return cleanTarget;
      }
      return fromHash;
    }
    // Hash mode with empty hash: root landing path
    if (isHashRouting()) {
      return "/";
    }
  }

  // Pathname mode (hosted domain / localhost)
  const pathname = window.location.pathname;
  return pathname || "/";
}

/**
 * Parses any path or hash string into a typed Route object.
 *
 * Supported paths:
 *   / or /home or /overview   → home (product landing page showcase)
 *   /app or /drop or /post    → drop (app posting flow)
 *   /d/<ref> or /reader/<ref> → reader (CID / storage proof verification)
 *   /groups                   → groups (issuer membership management)
 *   /settings                 → settings (transports, delays, pinners)
 *   /about                    → about (threat model and design)
 */
export function parseRoute(rawPath: string): Route {
  const path = rawPath.replace(/^#/, "");
  const [head, ...rest] = path.split("/").filter(Boolean);

  if (!head || head === "home" || head === "overview") {
    return { name: "home" };
  }
  if (head === "app" || head === "drop" || head === "post") {
    return { name: "drop" };
  }
  if (head === "d" || head === "reader" || head === "read") {
    return { name: "reader", ref: decodeURIComponent(rest.join("/")) };
  }
  if (head === "groups") {
    return { name: "groups" };
  }
  if (head === "settings") {
    return { name: "settings" };
  }
  if (head === "about") {
    return { name: "about" };
  }
  // Default is "home" (Landing Page front door)
  return { name: "home" };
}

/**
 * Generates an environment-aware href attribute.
 *
 * In clean path mode: returns `/`, `/app`, `/d/123`, etc.
 * In hash mode (file:// or /ipfs/): returns `#/`, `#/app`, `#/d/123`, etc.
 */
export function toHref(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (isHashRouting()) {
    if (clean === "/" || clean === "") return "#/";
    return `#${clean}`;
  }
  return clean;
}

/**
 * Helper to build reader links.
 */
export function readerHref(ref?: string): string {
  return toHref(`/d/${ref ? encodeURIComponent(ref) : ""}`);
}

/**
 * Programmatic SPA navigation that respects the active router mode.
 */
export function navigate(path: string, options?: { replace?: boolean }): void {
  if (typeof window === "undefined") return;

  const clean = path.startsWith("/") ? path : `/${path}`;

  if (isHashRouting()) {
    const targetHash = clean === "/" ? "#/" : `#${clean}`;
    if (window.location.hash === targetHash) return;
    if (options?.replace) {
      const url = new URL(window.location.href);
      url.hash = targetHash;
      window.location.replace(url.href);
    } else {
      window.location.hash = targetHash;
    }
  } else {
    if (window.location.pathname === clean && !window.location.hash) return;
    if (options?.replace) {
      window.history.replaceState(null, "", clean);
    } else {
      window.history.pushState(null, "", clean);
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

/**
 * React hook that subscribes to route changes.
 */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(getCurrentPath()));

  useEffect(() => {
    const update = () => setRoute(parseRoute(getCurrentPath()));
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);

  return route;
}

/**
 * Global single-page navigation click interceptor.
 * Intercepts internal link clicks so clean path links (/drop, /settings) navigate
 * instantly via history.pushState without a full browser reload.
 */
if (typeof window !== "undefined") {
  window.addEventListener("click", (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    // Ignore external, target="_blank", mailto, and download links
    if (anchor.getAttribute("target") === "_blank" || anchor.hasAttribute("download")) return;
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) return;

    // In-page anchor jumps (e.g. #how-it-works on landing page)
    if (href.startsWith("#") && !href.startsWith("#/")) return;

    // In hash routing mode
    if (isHashRouting()) {
      if (href.startsWith("#/")) {
        // Native hashchange handles this
        return;
      }
      if (href.startsWith("/") && !href.startsWith("//")) {
        event.preventDefault();
        navigate(href);
        return;
      }
      return;
    }

    // In clean pathname mode
    if (href.startsWith("/") && !href.startsWith("//")) {
      event.preventDefault();
      navigate(href);
      return;
    }

    if (href.startsWith("#/")) {
      event.preventDefault();
      navigate(href.replace(/^#/, ""));
      return;
    }
  });
}
