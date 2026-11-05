import { useEffect, useState } from "react";
import { commitmentHex } from "@zerodrop/core";
import { loadGroups, readClient, type GroupView } from "../lib/chain";
import type { Identity } from "../lib/session";
import { Tick, short } from "./Shell";

type Props = { identity: Identity | undefined };

export function GroupsPage({ identity }: Props) {
  const [groups, setGroups] = useState<GroupView[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      setGroups(await loadGroups(readClient()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const commitment = identity ? commitmentHex(identity) : undefined;

  return (
    <section>
      <p className="eyebrow">Groups</p>
      <h1 className="page-title">Groups on this chain</h1>
      <p className="lede">Groups and their members are read from chain events. A group's root is rebuilt here and compared with the root the issuer published.</p>

      <div className="card raised">
        <h2>Your commitment</h2>
        {commitment ? (
          <>
            <code className="digest">{commitment}</code>
            <p className="small muted card-sub">Give this value to the group's issuer, out of band (for example a file or a QR code). Joining is public; posting is not.</p>
          </>
        ) : <p className="muted">No identity yet. Create one on the Post page.</p>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{loading ? "Loading…" : `${groups?.length ?? 0} groups`}</h2>
          <button className="secondary" onClick={() => void refresh()}>Refresh</button>
        </div>
        {error && <div className="warn"><span className="warn-dot" aria-hidden="true" />{error}</div>}
        {groups?.length === 0 && <p className="muted">No groups yet.</p>}
        <ul className="group-list">
          {groups?.map((g) => <GroupRow key={g.groupId.toString()} view={g} member={!!identity && g.commitments.some((c) => c === identity.commitment)} />)}
        </ul>
      </div>

      <div className="card">
        <h2>Add members (issuer)</h2>
        <p className="small muted card-sub">Adding members is out of scope for the app. The issuer adds commitments with ZeroDrop.addMembers(groupId, commitments, newRoot), and the new root is computed from the member list.</p>
        <p className="small muted">The spec names scripts/seed-group.ts for this. That file is not in the repository, so no issuer command is shown here until it exists. scripts/check-local.ts creates a group with fixture commitments for smoke tests only.</p>
      </div>
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
