import { useEffect, useState } from "react";
import { useRoute } from "../lib/router";
import { restoreIdentity, type Identity } from "../lib/session";
import { Shell } from "./Shell";
import { DropPage } from "./DropPage";
import { ReaderPage } from "./ReaderPage";
import { GroupsPage } from "./GroupsPage";
import { SettingsPage } from "./SettingsPage";
import { AboutPage } from "./AboutPage";

export function App() {
  const route = useRoute();
  const [identity, setIdentity] = useState<Identity>();
  const [identityChecked, setIdentityChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void restoreIdentity().then((saved) => {
      if (cancelled) return;
      setIdentity(saved);
      setIdentityChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  let page;
  switch (route.name) {
    case "drop":
      page = <DropPage identity={identity} setIdentity={setIdentity} identityChecked={identityChecked} />;
      break;
    case "reader":
      page = <ReaderPage key={route.ref} reference={route.ref} />;
      break;
    case "groups":
      page = <GroupsPage identity={identity} />;
      break;
    case "settings":
      page = <SettingsPage identity={identity} setIdentity={setIdentity} />;
      break;
    case "about":
      page = <AboutPage />;
      break;
  }

  return <Shell route={route}>{page}</Shell>;
}
