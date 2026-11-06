import { useEffect } from "react";
import { useRoute, type Route } from "../lib/router";
import { Shell } from "./Shell";
import { LandingPage } from "./LandingPage";
import { DropPage } from "./DropPage";
import { ReaderPage } from "./ReaderPage";
import { GroupsPage } from "./GroupsPage";
import { SettingsPage } from "./SettingsPage";
import { AboutPage } from "./AboutPage";

const DEFAULT_DESCRIPTION = "Publish documents without publishing who you are.";

/** Document title and meta description per route. Set on every route change. */
const ROUTE_META: Record<Route["name"], { title: string; description: string }> = {
  drop: {
    title: "ZeroDrop: Post a Document",
    description: "Strip metadata, prove membership in zero-knowledge, and publish a document anonymously on chain. No ETH, no wallet, no relayer.",
  },
  home: {
    title: "ZeroDrop: Relayerless Anonymous Disclosure Protocol",
    description: "Publish a document that anyone can verify came from a group member, without revealing which member. EIP-8141 Alt-Mempool + Anon-RPC + Semaphore ZK.",
  },
  reader: { title: "Verify a Disclosure · ZeroDrop", description: DEFAULT_DESCRIPTION },
  groups: { title: "Issuer Groups · ZeroDrop", description: DEFAULT_DESCRIPTION },
  settings: { title: "Settings · ZeroDrop", description: DEFAULT_DESCRIPTION },
  about: { title: "About ZeroDrop", description: DEFAULT_DESCRIPTION },
};

export function App() {
  const route = useRoute();

  useEffect(() => {
    const meta = ROUTE_META[route.name];
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
  }, [route.name]);

  // The landing page has its own header and footer; the app Shell is for the app routes only.
  if (route.name === "home") return <LandingPage />;

  let page;
  switch (route.name) {
    case "drop":
      page = <DropPage />;
      break;
    case "reader":
      page = <ReaderPage key={route.ref} reference={route.ref} />;
      break;
    case "groups":
      page = <GroupsPage />;
      break;
    case "settings":
      page = <SettingsPage />;
      break;
    case "about":
      page = <AboutPage />;
      break;
  }

  return <Shell route={route}>{page}</Shell>;
}
