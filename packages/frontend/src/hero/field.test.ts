import { describe, expect, it } from "vitest";

import { computeLinks, createNodes, stepNodes, type FieldNode } from "./field";

/** A deterministic sequence, so a failure is reproducible rather than a one-in-a-thousand. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("createNodes", () => {
  it("creates the requested count", () => {
    const nodes = createNodes({ count: 40, linkDistance: 0.4, speed: 0.1, random: seeded(1) });
    expect(nodes).toHaveLength(40);
  });

  it("places every node inside the normalised box", () => {
    const nodes = createNodes({ count: 200, linkDistance: 0.4, speed: 0.1, random: seeded(7) });

    for (const node of nodes) {
      expect(Math.abs(node.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.z)).toBeLessThanOrEqual(1);
    }
  });

  it("gives every node a non-zero velocity, so none sits frozen in the field", () => {
    const nodes = createNodes({ count: 60, linkDistance: 0.4, speed: 0.1, random: seeded(3) });

    for (const node of nodes) {
      expect(Math.hypot(node.vx, node.vy, node.vz)).toBeGreaterThan(0);
    }
  });
});

describe("stepNodes", () => {
  it("moves a node along its velocity", () => {
    const nodes: FieldNode[] = [{ x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }];
    stepNodes(nodes, 0.02);
    expect(nodes[0]!.x).toBeCloseTo(0.02);
  });

  it("clamps a huge delta instead of teleporting the field", () => {
    // A backgrounded tab resumes with an enormous delta. Unclamped, every node jumps
    // across the field in one frame and the animation visibly snaps.
    const nodes: FieldNode[] = [{ x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }];
    stepNodes(nodes, 30);
    expect(nodes[0]!.x).toBeLessThanOrEqual(0.05);
  });

  it("ignores a negative delta rather than running backwards", () => {
    const nodes: FieldNode[] = [{ x: 0.5, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }];
    stepNodes(nodes, -5);
    expect(nodes[0]!.x).toBe(0.5);
  });

  it("wraps a node that leaves the box to the opposite face", () => {
    // Wrapping rather than bouncing is what keeps the density even; bouncing collects
    // nodes along the edges over time and the mesh stops reading as a mesh.
    const nodes: FieldNode[] = [{ x: 0.999, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }];
    stepNodes(nodes, 0.05);
    expect(nodes[0]!.x).toBeCloseTo(-1);
  });

  it("keeps every node in the box over a long run", () => {
    const nodes = createNodes({ count: 80, linkDistance: 0.4, speed: 0.5, random: seeded(11) });

    for (let i = 0; i < 500; i += 1) stepNodes(nodes, 0.016);

    for (const node of nodes) {
      expect(Math.abs(node.x)).toBeLessThanOrEqual(1.001);
      expect(Math.abs(node.y)).toBeLessThanOrEqual(1.001);
      expect(Math.abs(node.z)).toBeLessThanOrEqual(1.001);
    }
  });
});

describe("computeLinks", () => {
  it("links a pair inside the distance", () => {
    const nodes: FieldNode[] = [
      { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      { x: 0.1, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    ];
    expect(computeLinks(nodes, 0.5)).toHaveLength(1);
  });

  it("does not link a pair outside it", () => {
    const nodes: FieldNode[] = [
      { x: -1, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      { x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    ];
    expect(computeLinks(nodes, 0.5)).toHaveLength(0);
  });

  it("reports a stronger link for a closer pair, so the mesh fades at its edges", () => {
    const near = computeLinks(
      [
        { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        { x: 0.05, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      ],
      0.5,
    );
    const far = computeLinks(
      [
        { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        { x: 0.45, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      ],
      0.5,
    );

    expect(near[0]!.strength).toBeGreaterThan(far[0]!.strength);
  });

  it("keeps strength within 0..1", () => {
    const nodes = createNodes({ count: 60, linkDistance: 0.5, speed: 0.1, random: seeded(5) });

    for (const link of computeLinks(nodes, 0.5)) {
      expect(link.strength).toBeGreaterThanOrEqual(0);
      expect(link.strength).toBeLessThanOrEqual(1);
    }
  });

  it("never pairs a node with itself or repeats a pair", () => {
    const nodes = createNodes({ count: 40, linkDistance: 2, speed: 0.1, random: seeded(9) });
    const seen = new Set<string>();

    for (const link of computeLinks(nodes, 2, 100_000)) {
      expect(link.a).not.toBe(link.b);
      const key = `${Math.min(link.a, link.b)}-${Math.max(link.a, link.b)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("stops at the ceiling rather than letting the frame budget go", () => {
    // Everything is within range here, so without the cap this is 4950 links.
    const nodes = createNodes({ count: 100, linkDistance: 4, speed: 0, random: seeded(13) });
    expect(computeLinks(nodes, 4, 50)).toHaveLength(50);
  });
});
