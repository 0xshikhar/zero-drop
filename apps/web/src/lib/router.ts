import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "drop" }
  | { name: "reader"; ref: string }
  | { name: "groups" }
  | { name: "settings" }
  | { name: "about" };

/**
 * Parses the hash. Routes: #/home (the landing page), #/drop, #/d/<cid or digest> (#/d/ alone opens the
 * reader's lookup), #/groups, #/settings, #/about. The empty hash and #/ are the landing page too, and so is
 * any unknown route: an unrecognised link lands on the front door, not in the app.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const [head, ...rest] = path.split("/").filter(Boolean);
  if (head === "d") return { name: "reader", ref: decodeURIComponent(rest.join("/")) };
  if (head === "drop") return { name: "drop" };
  if (head === "groups") return { name: "groups" };
  if (head === "settings") return { name: "settings" };
  if (head === "about") return { name: "about" };
  return { name: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function readerHref(ref: string): string {
  return `#/d/${ref}`;
}
