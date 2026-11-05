import { Group } from "@semaphore-protocol/group";

export type GroupSnapshot = { root: bigint; size: number; group: Group };

export type MembersAddedEvent = { startIndex: number; commitments: bigint[] };

/** Builds a LeanIMT group from commitments in order. Index i of the input is leaf i. */
export function buildGroup(commitments: bigint[]): GroupSnapshot {
  const group = new Group(commitments);
  return { root: group.root, size: group.size, group };
}

/**
 * Rebuilds the group from MembersAdded-style events, given in the order they were emitted.
 * Each batch must start exactly where the previous one ended (startIndex continuity), otherwise
 * this throws: a gap or overlap means the event log is incomplete or was reordered.
 */
export function rebuildFromEvents(events: MembersAddedEvent[]): GroupSnapshot {
  const group = new Group();
  let expected = 0;
  for (const [i, event] of events.entries()) {
    if (!Number.isSafeInteger(event.startIndex) || event.startIndex < 0) {
      throw new Error(`Event ${i} has an invalid startIndex`);
    }
    if (event.startIndex !== expected) {
      throw new Error(`Event ${i} starts at ${event.startIndex}, expected ${expected}`);
    }
    for (const commitment of event.commitments) {
      group.addMember(commitment);
    }
    expected += event.commitments.length;
  }
  return { root: group.root, size: group.size, group };
}

/**
 * Root for every prefix of the commitment list: result[k] is the root after the first k members
 * (result[0] is 0n for the empty group). Use it to see which group size a proof's root corresponds to.
 */
export function rootSize(commitments: bigint[]): bigint[] {
  const group = new Group();
  const roots: bigint[] = [0n];
  for (const commitment of commitments) {
    group.addMember(commitment);
    roots.push(group.root);
  }
  return roots;
}

/**
 * Returns the group size k whose root equals `root` (the smallest such k, at least 1), or undefined
 * when no prefix of `commitments` has that root.
 */
export function sizeAtRoot(commitments: bigint[], root: bigint): number | undefined {
  const roots = rootSize(commitments);
  for (let k = 1; k < roots.length; k++) {
    if (roots[k] === root) return k;
  }
  return undefined;
}
