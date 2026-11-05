import { useEffect, useMemo, useState } from "react";
import { buildGroup, commitmentHex } from "@zerodrop/core";
import { parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { zeroDropAbi } from "../lib/adapter";
import { loadGroups, readClient, requireDeployment, walletFor, type GroupView } from "../lib/chain";
import { networkGate, useBootState, useNetworkPlan } from "../lib/network";
import { useDeployment, useSettings } from "../lib/prefs";
import { useSession } from "../lib/session";
import { IdentityHint } from "./IdentityPanel";
import { download, errorMessage, short } from "../lib/util";
import { Card, CopyButton, Tick, Warn } from "./common";


const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Accepts 0x hex or decimal, one per line. Blank lines and lines starting with # are ignored. */
export function parseCommitments(text: string): { values: bigint[]; errors: string[] } {
  const values: bigint[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(line)) {
      errors.push(`Line ${i + 1}: not a hex (0x…) or decimal number.`);
      return;
    }
    const value = BigInt(line);
    if (value === 0n) errors.push(`Line ${i + 1}: a commitment cannot be zero.`);
    else if (value >= FIELD) errors.push(`Line ${i + 1}: larger than the BN254 scalar field.`);
    else values.push(value);
  });
  const seen = new Set<bigint>();
  for (const v of values) {
    if (seen.has(v)) errors.push(`Duplicate commitment ${short(`0x${v.toString(16)}`, 10, 6)}.`);
    seen.add(v);
  }
  return { values, errors };
}

export function GroupsPage() {
  const { identity } = useSession();
  const deployment = useDeployment();
  const settings = useSettings();
  const plan = useNetworkPlan();
  const boot = useBootState();
  const gate = networkGate(plan, boot);

  const [groups, setGroups] = useState<GroupView[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      setGroups(await loadGroups(readClient("reader")));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const rpcKey = settings.rpcUrls.join(",") + String(settings.directRpcForReader);
  useEffect(() => {
    if (deployment && gate.ok) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment?.id, rpcKey, gate.ok]);

  const commitment = identity ? commitmentHex(identity) : undefined;

  if (!deployment) return <section><h1 className="page-title">Groups</h1><Warn>No usable deployment in config/.</Warn></section>;

  return (
    <section>
      <p className="eyebrow">Groups</p>
      <h1 className="page-title">Groups on this chain</h1>
      <p className="lede">Groups and their members are read from chain events on {deployment.label}. A group's root is rebuilt here and compared with the root the issuer published.</p>
      {!gate.ok && <Warn>{gate.message}</Warn>}

      <Card title="Your commitment" subtitle="Give this value to the group's issuer, out of band (a message or a file). Joining is public; posting is not.">
        {commitment ? (
          <>
            <code className="digest" data-testid="own-commitment">{commitment}</code>
            <div className="actions tight">
              <CopyButton text={commitment} label="Copy commitment" />
              <button className="secondary small-btn" onClick={() => download("zerodrop-commitment.txt", `${commitment}\n`, "text/plain")}>Download commitment file</button>
            </div>
          </>
        ) : <IdentityHint />}
      </Card>

      <div className="card">
        <div className="card-head">
          <h2>{loading ? "Loading…" : `${groups?.length ?? 0} group${groups?.length === 1 ? "" : "s"}`}</h2>
          <button className="secondary" onClick={() => void refresh()} disabled={!gate.ok}>Refresh</button>
        </div>
        {error && <Warn>{error}</Warn>}
        {groups?.length === 0 && <p className="muted">No groups yet.</p>}
        <ul className="group-list">
          {groups?.map((g) => <GroupRow key={g.groupId.toString()} view={g} member={!!identity && g.commitments.some((c) => c === identity.commitment)} />)}
        </ul>
      </div>

      <IssuerPanel groups={groups} onChanged={refresh} gateOk={gate.ok} />
    </section>
  );
}

function GroupRow({ view, member }: { view: GroupView; member: boolean }) {
  return (
    <li className="group-row">
      <div className="group-title">
        <strong>Group {view.groupId.toString()}</strong>
        <span className="mono small muted">{view.commitments.length} members · min {view.minSize}</span>
      </div>
      <div className="small muted">Issuer <code className="mono">{short(view.issuer, 8, 6)}</code></div>
      <div className="small">
        {view.rootMatches ? <Tick>Root matches chain</Tick> : <span className="error-text">{view.error ?? "No published root"}</span>}
      </div>
      {member && <div className="small"><Tick>Your commitment is a member</Tick></div>}
    </li>
  );
}

/** Issuer tools. The pasted key is component state only: never stored, cleared on unmount. */
function IssuerPanel({ groups, onChanged, gateOk }: { groups: GroupView[] | undefined; onChanged: () => Promise<void>; gateOk: boolean }) {
  const [key, setKey] = useState("");
  const [minSize, setMinSize] = useState("3");
  const [groupId, setGroupId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const keyValid = PRIVATE_KEY.test(key.trim());
  const issuerAddress = useMemo(() => (keyValid ? privateKeyToAccount(key.trim() as Hex).address : undefined), [key, keyValid]);
  const mine = groups?.filter((g) => !issuerAddress || g.issuer.toLowerCase() === issuerAddress.toLowerCase()) ?? [];
  const selected = groups?.find((g) => g.groupId.toString() === groupId) ?? mine[0];
  const parsed = useMemo(() => parseCommitments(text), [text]);

  const preview = useMemo(() => {
    if (!selected || parsed.values.length === 0 || parsed.errors.length > 0) return undefined;
    const existing = new Set(selected.commitments);
    if (parsed.values.some((v) => existing.has(v))) return { error: "One or more commitments are already members." } as const;
    const all = [...selected.commitments, ...parsed.values];
    return { size: all.length, root: buildGroup(all).root } as const;
  }, [selected, parsed]);

  async function loadFile(file?: File) {
    if (!file) return;
    const content = await file.text();
    setText((prev) => (prev.trim() ? `${prev.trim()}\n${content.trim()}` : content.trim()));
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage({ ok: true, text: await action() });
      await onChanged();
    } catch (error) {
      setMessage({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    await run(async () => {
      const d = requireDeployment();
      const size = Number(minSize);
      if (!Number.isInteger(size) || size < 1) throw new Error("Minimum size must be a whole number of at least 1.");
      const account = privateKeyToAccount(key.trim() as Hex);
      const hash = await walletFor(account, "issuer").writeContract({ address: d.zeroDrop, abi: zeroDropAbi, functionName: "createGroup", args: [size] });
      const receipt = await readClient("issuer").waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`createGroup reverted (${hash})`);
      const [event] = parseEventLogs({ abi: zeroDropAbi, logs: receipt.logs as never, eventName: "GroupCreated" });
      const id = (event?.args as { groupId?: bigint } | undefined)?.groupId;
      if (id !== undefined) setGroupId(id.toString());
      return `Created group ${id?.toString() ?? "?"} (min size ${size}) in transaction ${short(hash, 12, 8)}.`;
    });
  }

  async function addMembers() {
    if (!selected || !preview || "error" in preview) return;
    await run(async () => {
      const d = requireDeployment();
      const account = privateKeyToAccount(key.trim() as Hex);
      // Rebuild from the chain again right before sending, so a stale list cannot produce a wrong root.
      const fresh = (await loadGroups(readClient("issuer"))).find((g) => g.groupId === selected.groupId);
      if (!fresh) throw new Error("The group was not found on chain.");
      if (!fresh.rootMatches && fresh.commitments.length > 0) throw new Error("The rebuilt root differs from the root on chain; not adding members to a group whose history does not rebuild.");
      const all = [...fresh.commitments, ...parsed.values];
      const newRoot = buildGroup(all).root;
      const args = [fresh.groupId, parsed.values, newRoot] as const;
      await readClient("issuer").simulateContract({ account: account.address, address: d.zeroDrop, abi: zeroDropAbi, functionName: "addMembers", args });
      const hash = await walletFor(account, "issuer").writeContract({ address: d.zeroDrop, abi: zeroDropAbi, functionName: "addMembers", args });
      const receipt = await readClient("issuer").waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`addMembers reverted (${hash})`);
      setText("");
      return `Added ${parsed.values.length} member${parsed.values.length === 1 ? "" : "s"} to group ${fresh.groupId}. New size ${all.length}, root ${short(`0x${newRoot.toString(16)}`, 12, 8)}.`;
    });
  }

  return (
    <Card title="Issuer tools" subtitle="Create a group and add members. Paste a funded dev account key: it is kept in this page's memory only, never saved, and gone when you leave." raised={false}>
      <Warn>Joining is public: anyone reading the chain sees which commitments were added to the group. Use a throwaway dev key on a local chain.</Warn>
      <label className="field">
        <span className="field-label">Issuer account private key</span>
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="0x…" aria-label="Issuer account private key" />
        {key && !keyValid && <span className="small warning-text">Expected 0x followed by 64 hex characters.</span>}
        {issuerAddress && <span className="small muted mono">Address {issuerAddress}</span>}
      </label>

      <h3 className="sub">Create a group</h3>
      <div className="inline-form">
        <label className="field narrow">
          <span className="field-label">Minimum size</span>
          <input inputMode="numeric" value={minSize} onChange={(e) => setMinSize(e.target.value)} aria-label="Minimum group size" />
        </label>
        <button className="secondary" disabled={busy || !keyValid || !gateOk} onClick={() => void createGroup()}>Create group</button>
      </div>

      <h3 className="sub">Add members</h3>
      <label className="field">
        <span className="field-label">Group</span>
        <select value={selected?.groupId.toString() ?? ""} onChange={(e) => setGroupId(e.target.value)} aria-label="Group to add members to">
          {(mine.length > 0 ? mine : (groups ?? [])).map((g) => (
            <option key={g.groupId.toString()} value={g.groupId.toString()}>Group {g.groupId.toString()} · {g.commitments.length} members · min {g.minSize}{issuerAddress && g.issuer.toLowerCase() !== issuerAddress.toLowerCase() ? " · not your group" : ""}</option>
          ))}
        </select>
      </label>
      {selected && issuerAddress && selected.issuer.toLowerCase() !== (issuerAddress as Address).toLowerCase() && <Warn>This key is not the issuer of group {selected.groupId.toString()}; the contract would reject the call.</Warn>}
      <label className="field">
        <span className="field-label">Commitments, one per line (0x hex or decimal)</span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={"0x…\n0x…"} aria-label="Commitments to add" />
      </label>
      <input className="file-input" type="file" accept=".txt,.json,text/plain" onChange={(e) => void loadFile(e.target.files?.[0])} aria-label="Load commitments from a file" />
      {parsed.errors.map((e) => <p key={e} className="small error-text">{e}</p>)}
      {preview && ("error" in preview ? <p className="small error-text">{preview.error}</p> : <p className="small mono muted" data-testid="new-root">{parsed.values.length} to add. New size {preview.size}, new root {short(`0x${preview.root.toString(16)}`, 14, 8)}</p>)}
      <div className="actions">
        <button className="primary" disabled={busy || !keyValid || !gateOk || !selected || !preview || "error" in preview} onClick={() => void addMembers()}>{busy ? "Working…" : "Add members"}</button>
      </div>
      {message && <p className={message.ok ? "small verified" : "small error-text"} role="status" data-testid="issuer-message">{message.text}</p>}
    </Card>
  );
}

