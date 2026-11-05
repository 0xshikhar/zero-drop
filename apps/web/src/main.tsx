import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { startNetwork } from "./lib/network";
import "./styles/tokens.css";

// Decide direct or anonymous routing from the settings and the active deployment before the first request.
startNetwork();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
