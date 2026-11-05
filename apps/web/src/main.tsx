import React from "react";
import { createRoot } from "react-dom/client";
import { proofStatus } from "@zerodrop/core";
import { App } from "./ui/App";
import "./styles/tokens.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App proof={proofStatus()} /></React.StrictMode>,
);
