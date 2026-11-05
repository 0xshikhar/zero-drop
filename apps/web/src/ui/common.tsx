import { useState, type ReactNode } from "react";
import { copyText } from "../lib/util";

export function Card({ title, subtitle, children, raised = true }: { title: string; subtitle?: string; children: ReactNode; raised?: boolean }) {
  return (
    <div className={raised ? "card raised" : "card"}>
      <h2>{title}</h2>
      {subtitle && <p className="muted small card-sub">{subtitle}</p>}
      {children}
    </div>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return <div className="warn" role="status"><span className="warn-dot" aria-hidden="true" /><div>{children}</div></div>;
}

export function Info({ children }: { children: ReactNode }) {
  return <div className="info" role="status"><span className="info-dot" aria-hidden="true" /><div>{children}</div></div>;
}

export function Tick({ children }: { children?: ReactNode }) {
  return <span className="verified"><span aria-hidden="true">✓</span> {children ?? "Verified"}</span>;
}

/** Neutral/amber state for things that are present but prove nothing (a mock proof). Never a tick. */
export function MockMark({ children }: { children: ReactNode }) {
  return <span className="mockmark"><span aria-hidden="true">◇</span> {children}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  async function copy() {
    setState((await copyText(text)) ? "ok" : "fail");
    window.setTimeout(() => setState("idle"), 2000);
  }
  return (
    <button type="button" className="secondary small-btn" onClick={() => void copy()}>
      {state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}
