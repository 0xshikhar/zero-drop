import { useRoute } from "../lib/router";
import { Shell } from "./Shell";
import { DropPage } from "./DropPage";
import { ReaderPage } from "./ReaderPage";
import { GroupsPage } from "./GroupsPage";
import { SettingsPage } from "./SettingsPage";
import { AboutPage } from "./AboutPage";

export function App() {
  const route = useRoute();
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
