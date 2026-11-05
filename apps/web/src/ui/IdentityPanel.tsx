import { useState, type ReactNode } from "react";
import { MIN_PASSPHRASE_LENGTH, WrongPassphraseError, commitmentHex } from "@zerodrop/core";
import { useSession } from "../lib/session";
import { errorMessage } from "../lib/util";
import { Warn } from "./common";
import { DevDemoButton } from "./DevDemo";

/** A passphrase field with an optional confirm field. Submits through onSubmit; shows its own inline error. */
export function PassphraseForm({
  submitLabel,
  confirm = false,
  busyLabel = "Working…",
  onSubmit,
  extra,
  id,
}: {
  submitLabel: string;
  confirm?: boolean;
  busyLabel?: string;
  onSubmit: (passphrase: string) => Promise<void>;
  extra?: ReactNode;
  id: string;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm && again.length > 0 && again !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE_LENGTH && (!confirm || again === passphrase);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(passphrase);
      setPassphrase("");
      setAgain("");
    } catch (e) {
      setError(e instanceof WrongPassphraseError ? "Wrong passphrase." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} data-form={id}>
      <label className="field">
        <span className="field-label">Passphrase</span>
        <input
          type="password"
          autoComplete={confirm ? "new-password" : "current-password"}
          value={passphrase}
          onChange={(e) => { setPassphrase(e.target.value); setError(undefined); }}
          aria-label={`${id} passphrase`}
          aria-invalid={tooShort || !!error}
          data-testid={`${id}-passphrase`}
        />
        {confirm && <span className="small muted">At least {MIN_PASSPHRASE_LENGTH} characters.</span>}
        {tooShort && <span className="small warning-text"> {passphrase.length} of {MIN_PASSPHRASE_LENGTH} characters so far.</span>}
      </label>
      {confirm && (
        <label className="field">
          <span className="field-label">Repeat the passphrase</span>
          <input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-label={`${id} passphrase again`}
            data-testid={`${id}-passphrase-again`}
          />
          {mismatch && <span className="small warning-text">The two passphrases differ.</span>}
        </label>
      )}
      {extra}
      {error && <p className="small error-text" role="alert" data-testid={`${id}-error`}>{error}</p>}
      <div className="actions tight">
        <button type="submit" className="primary" disabled={!ready || busy} data-testid={`${id}-submit`}>{busy ? busyLabel : submitLabel}</button>
      </div>
    </form>
  );
}

/**
 * The identity step: create (with a mandatory passphrase), unlock, or protect a legacy plain record.
 * When the identity is unlocked it renders `unlocked` (the commitment and a continue button, from the caller).
 */
export function IdentityPanel({ unlocked }: { unlocked: (commitment: string) => ReactNode }) {
  const s = useSession();
  const { actions } = s;

  if (s.status === "checking") return <p className="muted">Checking for a saved identity…</p>;

  if (s.status === "unlocked" && s.identity) {
    const commitment = commitmentHex(s.identity);
    return (
      <>
        <p className="field-label">Commitment (give this to the issuer)</p>
        <code className="digest" data-testid="commitment">{commitment}</code>
        {s.ephemeral ? <EphemeralNotice /> : s.volatile ? (
          <Warn>This browser would not keep the encrypted identity, so it will be gone after a reload. Export an encrypted backup from Settings before you leave the page.</Warn>
        ) : (
          <p className="muted small" data-testid="saved-note">Saved in this browser, encrypted with your passphrase. It is unlocked for this session; lock it from Settings.</p>
        )}
        {unlocked(commitment)}
      </>
    );
  }

  if (s.status === "locked") {
    return (
      <>
        <p>Your identity is stored in this browser, encrypted. Enter the passphrase to unlock it for this session.</p>
        <PassphraseForm id="unlock" submitLabel="Unlock" busyLabel="Unlocking…" onSubmit={(p) => actions.unlock(p)} />
        <p className="small muted">There is no recovery and no lockout. If you forgot the passphrase, restore from an encrypted backup in Settings, or delete the stored identity there and create a new one.</p>
        {import.meta.env.DEV && <DevDemoButton />}
      </>
    );
  }

  if (s.status === "legacy") {
    return (
      <>
        <Warn>An identity from an earlier version is stored in this browser <strong>unencrypted</strong>. Anyone who can read this browser profile can read it. It stays locked away from the app until you protect it.</Warn>
        <PassphraseForm id="protect-legacy" confirm submitLabel="Protect with a passphrase" busyLabel="Encrypting…" onSubmit={(p) => actions.protectLegacy(p)} />
        <p className="small muted">The unencrypted copy is deleted after the encrypted copy is written and read back.</p>
      </>
    );
  }

  // none
  if (s.draft) {
    return (
      <>
        <p className="field-label">New commitment (not saved yet)</p>
        <code className="digest" data-testid="draft-commitment">{commitmentHex(s.draft)}</code>
        <p>Choose a passphrase. The identity is encrypted with it (PBKDF2 and AES-GCM) before it is saved in this browser. It is not saved without one.</p>
        <Warn>There is no recovery. If you forget the passphrase the stored identity cannot be opened. After saving, export an encrypted backup from Settings.</Warn>
        <PassphraseForm id="create" confirm submitLabel="Encrypt and save" busyLabel="Encrypting…" onSubmit={(p) => actions.protectDraft(p)} />
        <div className="actions tight"><button className="link-button" onClick={() => actions.discardDraft()}>Cancel</button></div>
      </>
    );
  }

  return (
    <>
      <p>No identity yet.</p>
      <div className="actions tight">
        <button className="primary" onClick={() => actions.startDraft()} data-testid="create-identity">Create identity</button>
        {import.meta.env.DEV && <DevDemoButton />}
      </div>
    </>
  );
}

/** Shown for a dev demo identity that was never written to the vault. */
export function EphemeralNotice() {
  const { stored, actions } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="ephemeral-note">
      <Warn>This is a DEV demo identity. It is held in memory only and is not saved. It is gone after a reload.</Warn>
      {!open ? (
        <button className="link-button" onClick={() => setOpen(true)}>Save it with a passphrase</button>
      ) : (
        <>
          {stored !== "none" && <Warn>An identity is already stored in this browser. Saving this one replaces it.</Warn>}
          <PassphraseForm id="save-demo" confirm submitLabel="Encrypt and save" busyLabel="Encrypting…" onSubmit={(p) => actions.protectEphemeral(p)} />
        </>
      )}
    </div>
  );
}

/** Shown on pages that only read the identity (Groups) when it is not available. */
export function IdentityHint() {
  const s = useSession();
  if (s.status === "checking") return <p className="muted">Checking for a saved identity…</p>;
  if (s.status === "locked") return <p className="muted">Your identity is locked. <a className="brass-link" href="#/drop">Unlock it on the Post page</a>.</p>;
  if (s.status === "legacy") return <p className="muted">An unencrypted identity is stored. <a className="brass-link" href="#/drop">Protect it with a passphrase on the Post page</a>.</p>;
  return <p className="muted">No identity yet. <a className="brass-link" href="#/drop">Create one on the Post page</a>.</p>;
}
