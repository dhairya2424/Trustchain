/**
 * The particle simulation, with no rendering in it at all.
 *
 * Both hero renderers — three.js and the 2D canvas fallback — drive this same simulation,
 * so the fallback is recognisably the same artwork rather than a different effect that
 * happens to appear on weaker devices. It also means the interesting logic (drift, wrap,
 * which nodes are linked) is plain arithmetic that can be tested without a graphics
 * context of any kind.
 *
 * Coordinates are normalised to -1..1 on each axis. Renderers scale to their own viewport,
 * which keeps the field looking the same on a phone and an ultrawide instead of sparse on
 * one and cramped on the other.
 */

export interface FieldNode {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface FieldOptions {
  count: number;
  /** Max distance at which two nodes are drawn as linked. */
  linkDistance: number;
  /** Units per second. */
  speed: number;
  /** Deterministic source so tests and snapshots are reproducible. */
  random?: () => number;
}

export interface Link {
  a: number;
  b: number;
  /** 0 at exactly linkDistance, 1 when coincident. Renderers fade a link out with it. */
  strength: number;
}

const TAU = Math.PI * 2;

export function createNodes(options: FieldOptions): FieldNode[] {
  const random = options.random ?? Math.random;
  const nodes: FieldNode[] = [];

  for (let i = 0; i < options.count; i += 1) {
    // Direction is sampled on a sphere and speed is constant, so the field drifts evenly
    // instead of favouring the diagonals the way independent per-axis velocities would.
    const theta = random() * TAU;
    const phi = Math.acos(2 * random() - 1);
    const speed = options.speed * (0.4 + random() * 0.6);

    nodes.push({
      x: random() * 2 - 1,
      y: random() * 2 - 1,
      z: random() * 2 - 1,
      vx: Math.sin(phi) * Math.cos(theta) * speed,
      vy: Math.sin(phi) * Math.sin(theta) * speed,
      vz: Math.cos(phi) * speed,
    });
  }

  return nodes;
}

/**
 * Advances the simulation.
 *
 * `deltaSeconds` is clamped because a backgrounded tab resumes with an enormous delta, and
 * an unclamped step would teleport every node across the field in a single frame — the
 * animation visibly "jumps" the moment you switch back to it.
 */
export function stepNodes(nodes: FieldNode[], deltaSeconds: number): void {
  const dt = Math.min(Math.max(deltaSeconds, 0), 0.05);

  for (const node of nodes) {
    node.x += node.vx * dt;
    node.y += node.vy * dt;
    node.z += node.vz * dt;

    // Wrap rather than bounce. Bouncing collects nodes at the edges over time; wrapping
    // keeps the density even, which is what makes the link pattern read as a mesh.
    if (node.x > 1) node.x = -1;
    else if (node.x < -1) node.x = 1;
    if (node.y > 1) node.y = -1;
    else if (node.y < -1) node.y = 1;
    if (node.z > 1) node.z = -1;
    else if (node.z < -1) node.z = 1;
  }
}

/**
 * Every pair closer than `linkDistance`.
 *
 * This is the O(n²) part and therefore the reason `count` is tuned down hard for the 2D
 * fallback: the cost is in the pair scan, not in the drawing. `maxLinks` is a hard ceiling
 * so a pathological configuration degrades by dropping links rather than by dropping the
 * frame rate to nothing.
 */
export function computeLinks(
  nodes: readonly FieldNode[],
  linkDistance: number,
  maxLinks = 1400,
): Link[] {
  const links: Link[] = [];
  const limitSquared = linkDistance * linkDistance;

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (!a) continue;

    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (!b) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;

      if (distanceSquared > limitSquared) continue;

      links.push({ a: i, b: j, strength: 1 - Math.sqrt(distanceSquared) / linkDistance });
      if (links.length >= maxLinks) return links;
    }
  }

  return links;
}

/** Tuning per renderer. The 2D path runs a much smaller field because its link scan is on the main thread with no GPU help. */
export const FIELD_PRESETS = {
  webgl: { count: 190, linkDistance: 0.42, speed: 0.075 },
  canvas2d: { count: 70, linkDistance: 0.5, speed: 0.06 },
} as const satisfies Record<string, Omit<FieldOptions, "random">>;
