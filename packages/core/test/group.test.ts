import { describe, expect, it } from "vitest";
import { buildGroup, rebuildFromEvents, rootSize, sizeAtRoot } from "../src/group";
import { commitment, createIdentity } from "../src/identity";

const commitments = Array.from({ length: 5 }, () => commitment(createIdentity()));

describe("group", () => {
  it("root is deterministic for the same commitments", () => {
    const a = buildGroup(commitments);
    const b = buildGroup([...commitments]);
    expect(a.size).toBe(5);
    expect(a.root).toBe(b.root);
    expect(a.root).not.toBe(0n);
  });

  it("rebuildFromEvents matches buildGroup, across batch boundaries", () => {
    const events = [
      { startIndex: 0, commitments: commitments.slice(0, 2) },
      { startIndex: 2, commitments: commitments.slice(2, 3) },
      { startIndex: 3, commitments: commitments.slice(3) },
    ];
    const rebuilt = rebuildFromEvents(events);
    expect(rebuilt.root).toBe(buildGroup(commitments).root);
    expect(rebuilt.size).toBe(5);
  });

  it("rebuildFromEvents rejects gaps, overlaps and bad start indexes", () => {
    expect(() =>
      rebuildFromEvents([
        { startIndex: 0, commitments: commitments.slice(0, 2) },
        { startIndex: 3, commitments: commitments.slice(2, 3) },
      ]),
    ).toThrow(/expected 2/);
    expect(() =>
      rebuildFromEvents([
        { startIndex: 0, commitments: commitments.slice(0, 2) },
        { startIndex: 1, commitments: commitments.slice(2, 3) },
      ]),
    ).toThrow(/expected 2/);
    expect(() => rebuildFromEvents([{ startIndex: 1, commitments: commitments.slice(0, 1) }])).toThrow(/expected 0/);
  });

  it("rootSize gives the root for each prefix, and sizeAtRoot finds the size", () => {
    const roots = rootSize(commitments);
    expect(roots).toHaveLength(6);
    expect(roots[0]).toBe(0n);
    expect(roots[5]).toBe(buildGroup(commitments).root);
    expect(roots[3]).toBe(buildGroup(commitments.slice(0, 3)).root);
    expect(sizeAtRoot(commitments, roots[3])).toBe(3);
    expect(sizeAtRoot(commitments, 1n)).toBeUndefined();
  });
});
