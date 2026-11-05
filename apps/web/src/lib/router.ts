import { useEffect, useState } from "react";

export type Route =
  | { name: "drop" }
  | { name: "reader"; ref: string }
  | { name: "groups" }
  | { name: "settings" }
  | { name: "about" };

/** Parses the hash (#/drop, #/d/<cid or digest> (#/d/ alone opens the reader's lookup), #/groups, #/settings, #/about). Unknown routes fall back to /drop. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/drop";
  const [head, ...rest] = path.split("/").filter(Boolean);
  if (head === "d") return { name: "reader", ref: decodeURIComponent(rest.join("/")) };
  if (head === "groups") return { name: "groups" };
  if (head === "settings") return { name: "settings" };
  if (head === "about") return { name: "about" };
  return { name: "drop" };
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
