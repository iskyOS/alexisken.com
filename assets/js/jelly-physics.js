// Soft-body "jelly" simulation + mesh generation.
//
// This file has no three.js dependency so it can be unit-tested in Node.
// The scene module (jelly.js) feeds the generated mesh into a BufferGeometry
// and copies `sim.positions` into the position attribute every frame.
//
// Model: every mesh vertex ("node") has a rest position r, a displacement d
// and a velocity u. Each step applies
//   * a spring pulling d back to zero (shape memory),
//   * a Laplacian coupling to neighbouring nodes (lets wobbles travel),
//   * viscous damping,
//   * whatever the user is doing (pokes, drags, hops).
// The base of the jelly is glued to the plate, so the bottom ring never moves
// and stiffness ramps up towards it.

export const JELLY_HEIGHT = 1.6;
export const JELLY_RADIUS = 1.0;

/** Profile of a gumdrop-shaped jelly, as [radius, height] pairs from the
 *  centre of the base up to the tip of the dome (for a lathe). */
export function buildJellyProfile(steps = 34) {
  const pts = [];
  pts.push([0, 0]);
  // little rounded fillet where the jelly meets the plate
  pts.push([JELLY_RADIUS * 0.93, 0]);
  pts.push([JELLY_RADIUS * 0.985, 0.025]);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = base, 1 = tip
    const y = 0.06 + (JELLY_HEIGHT - 0.06) * t;
    const taper = 1 - 0.22 * t;
    const dome = Math.sqrt(Math.max(0, 1 - Math.pow(t, 5.5)));
    const r = JELLY_RADIUS * taper * dome;
    pts.push([i === steps ? 0 : r, y]);
  }
  return pts;
}

/** Revolve a profile around the Y axis. Vertices that coincide (the seam and
 *  the poles) are merged so the surface is watertight and normals are smooth.
 *  Returns { positions: Float32Array, index: Uint32Array }. */
export function buildLatheMesh(profile, segments = 56) {
  const rows = profile.length;
  const keyOf = (x, y, z) =>
    `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const nodeIndex = new Map();
  const positions = [];
  const grid = new Int32Array((segments + 1) * rows);

  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    for (let j = 0; j < rows; j++) {
      const [pr, py] = profile[j];
      let x = pr * s;
      let z = pr * c;
      const y = py;
      if (Math.abs(x) < 1e-9) x = 0;
      if (Math.abs(z) < 1e-9) z = 0;
      const k = keyOf(x, y, z);
      let id = nodeIndex.get(k);
      if (id === undefined) {
        id = positions.length / 3;
        nodeIndex.set(k, id);
        positions.push(x, y, z);
      }
      grid[i * rows + j] = id;
    }
  }

  const index = [];
  const pushTri = (a, b, c) => {
    if (a === b || b === c || a === c) return; // degenerate (pole / seam)
    index.push(a, b, c);
  };
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = grid[i * rows + j];
      const b = grid[(i + 1) * rows + j];
      const c = grid[(i + 1) * rows + j + 1];
      const d = grid[i * rows + j + 1];
      pushTri(a, b, d);
      pushTri(c, d, b);
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) };
}

/** Unique neighbour lists (flat CSR layout) derived from triangle indices. */
function buildAdjacency(nodeCount, index) {
  const sets = Array.from({ length: nodeCount }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  const offsets = new Int32Array(nodeCount + 1);
  let total = 0;
  for (let i = 0; i < nodeCount; i++) { offsets[i] = total; total += sets[i].size; }
  offsets[nodeCount] = total;
  const neighbours = new Int32Array(total);
  let w = 0;
  for (let i = 0; i < nodeCount; i++) for (const n of sets[i]) neighbours[w++] = n;
  return { offsets, neighbours };
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const DEFAULT_PARAMS = {
  stiffness: 70,        // spring back to rest shape
  coupling: 240,        // neighbour coupling (wobble propagation)
  damping: 2.6,         // viscous damping
  anchorHeight: 0.14,   // below this height the jelly is glued to the plate
  maxStretch: 1.35,     // how far a grab can pull the jelly
  grabStiffness: 260,
  grabDamping: 14,
  grabRadius: 0.6,
  substep: 1 / 240,
};

export class JellySim {
  constructor(mesh, params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.rest = mesh.positions;
    this.index = mesh.index;
    this.count = this.rest.length / 3;
    this.positions = new Float32Array(this.rest);
    this.disp = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.force = new Float32Array(this.count * 3);
    this.restNormals = computeNormals(this.rest, this.index, new Float32Array(this.count * 3));
    const adj = buildAdjacency(this.count, this.index);
    this.adjOffsets = adj.offsets;
    this.adjNeighbours = adj.neighbours;

    // per-node freedom (0 = glued to the plate) and stiffness multiplier
    this.freedom = new Float32Array(this.count);
    this.stiffnessMul = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const h = this.rest[i * 3 + 1] / JELLY_HEIGHT;
      this.freedom[i] = smoothstep(0.0, this.params.anchorHeight, h);
      this.stiffnessMul[i] = 1 + 2.5 * (1 - smoothstep(0, 0.5, h));
    }

    this.grab = null; // { node, weights: Float32Array, target: [x,y,z] }
    this.time = 0;
    this._accum = 0;
    this.energy = 0;
  }

  /** Squared rest-space distance between node i and a point. */
  _dist2(i, x, y, z) {
    const dx = this.rest[i * 3] - x;
    const dy = this.rest[i * 3 + 1] - y;
    const dz = this.rest[i * 3 + 2] - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Nearest node to a local-space point (used for hit → node lookup). */
  nearestNode(x, y, z) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = this._dist2(i, x, y, z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Poke the jelly at a local-space point. The centre is pushed in along the
   * surface normal, a ring around it bulges out (volume-ish conservation),
   * and the whole body gets a little upward "boing" that leans away from
   * the poke so it visibly bounces.
   */
  poke(x, y, z, strength = 1, radius = 0.55) {
    const s2 = radius * radius;
    const lean = Math.hypot(x, z) > 1e-4 ? [x / Math.hypot(x, z), z / Math.hypot(x, z)] : [0, 0];
    for (let i = 0; i < this.count; i++) {
      const f = this.freedom[i];
      if (f === 0) continue;
      const q = this._dist2(i, x, y, z) / s2;
      if (q < 9) {
        // Mexican hat: negative (inward) at the centre, positive (outward) ring
        const hat = -(1 - q) * Math.exp(-q / 2) * 2.6 * strength;
        this.vel[i * 3] += this.restNormals[i * 3] * hat * f;
        this.vel[i * 3 + 1] += this.restNormals[i * 3 + 1] * hat * f;
        this.vel[i * 3 + 2] += this.restNormals[i * 3 + 2] * hat * f;
      }
      const h = this.rest[i * 3 + 1] / JELLY_HEIGHT;
      const boing = Math.pow(h, 1.6) * 1.1 * strength * f;
      this.vel[i * 3 + 1] += boing;
      this.vel[i * 3] -= lean[0] * boing * 0.55;
      this.vel[i * 3 + 2] -= lean[1] * boing * 0.55;
    }
  }

  /** Whole-body hop: the top springs up, the base stays put. */
  hop(strength = 1) {
    for (let i = 0; i < this.count; i++) {
      const h = this.rest[i * 3 + 1] / JELLY_HEIGHT;
      this.vel[i * 3 + 1] += Math.pow(h, 1.4) * 2.2 * strength * this.freedom[i];
    }
  }

  /** Squash the jelly straight down (used for the landing "plop" on load). */
  squash(strength = 1) {
    for (let i = 0; i < this.count; i++) {
      const h = this.rest[i * 3 + 1] / JELLY_HEIGHT;
      this.vel[i * 3 + 1] -= Math.pow(h, 1.2) * 3.2 * strength * this.freedom[i];
      const rx = this.rest[i * 3], rz = this.rest[i * 3 + 2];
      this.vel[i * 3] += rx * 0.9 * strength * this.freedom[i];
      this.vel[i * 3 + 2] += rz * 0.9 * strength * this.freedom[i];
    }
  }

  grabStart(node) {
    const r = this.params.grabRadius;
    const weights = new Float32Array(this.count);
    const gx = this.rest[node * 3], gy = this.rest[node * 3 + 1], gz = this.rest[node * 3 + 2];
    for (let i = 0; i < this.count; i++) {
      weights[i] = Math.exp(-this._dist2(i, gx, gy, gz) / (r * r)) * this.freedom[i];
    }
    this.grab = {
      node,
      weights,
      target: [this.positions[node * 3], this.positions[node * 3 + 1], this.positions[node * 3 + 2]],
    };
  }

  grabMove(x, y, z) {
    if (!this.grab) return;
    const n = this.grab.node;
    // soft-limit how far the grabbed point can be pulled from its rest spot
    const rx = this.rest[n * 3], ry = this.rest[n * 3 + 1], rz = this.rest[n * 3 + 2];
    let dx = x - rx, dy = y - ry, dz = z - rz;
    const len = Math.hypot(dx, dy, dz);
    const max = this.params.maxStretch;
    if (len > 1e-6) {
      const soft = max * Math.tanh(len / max);
      dx *= soft / len; dy *= soft / len; dz *= soft / len;
    }
    this.grab.target[0] = rx + dx;
    this.grab.target[1] = Math.max(0.05, ry + dy);
    this.grab.target[2] = rz + dz;
  }

  grabEnd() {
    this.grab = null;
  }

  /** Advance the simulation by `dt` seconds using fixed substeps. */
  update(dt) {
    dt = Math.min(dt, 1 / 20);
    this._accum += dt;
    const h = this.params.substep;
    let steps = 0;
    while (this._accum >= h && steps < 16) {
      this._step(h);
      this._accum -= h;
      steps++;
    }
    if (steps === 16) this._accum = 0;
    return steps > 0;
  }

  _step(h) {
    const { stiffness, coupling, damping, grabStiffness, grabDamping } = this.params;
    const n = this.count;
    const d = this.disp, v = this.vel, f = this.force, rest = this.rest;
    const off = this.adjOffsets, nb = this.adjNeighbours;

    f.fill(0);
    for (let i = 0; i < n; i++) {
      if (this.freedom[i] === 0) continue;
      const i3 = i * 3;
      const k = stiffness * this.stiffnessMul[i];
      let fx = -k * d[i3] - damping * v[i3];
      let fy = -k * d[i3 + 1] - damping * v[i3 + 1];
      let fz = -k * d[i3 + 2] - damping * v[i3 + 2];
      for (let a = off[i]; a < off[i + 1]; a++) {
        const j3 = nb[a] * 3;
        fx += coupling * (d[j3] - d[i3]);
        fy += coupling * (d[j3 + 1] - d[i3 + 1]);
        fz += coupling * (d[j3 + 2] - d[i3 + 2]);
      }
      f[i3] = fx; f[i3 + 1] = fy; f[i3 + 2] = fz;
    }

    if (this.grab) {
      const g = this.grab;
      const g3 = g.node * 3;
      const ex = g.target[0] - (rest[g3] + d[g3]);
      const ey = g.target[1] - (rest[g3 + 1] + d[g3 + 1]);
      const ez = g.target[2] - (rest[g3 + 2] + d[g3 + 2]);
      for (let i = 0; i < n; i++) {
        const w = g.weights[i];
        if (w < 1e-3) continue;
        const i3 = i * 3;
        f[i3] += w * (grabStiffness * ex - grabDamping * v[i3]);
        f[i3 + 1] += w * (grabStiffness * ey - grabDamping * v[i3 + 1]);
        f[i3 + 2] += w * (grabStiffness * ez - grabDamping * v[i3 + 2]);
      }
    }

    let energy = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const fr = this.freedom[i];
      if (fr === 0) continue;
      v[i3] += f[i3] * h;
      v[i3 + 1] += f[i3 + 1] * h;
      v[i3 + 2] += f[i3 + 2] * h;
      d[i3] += v[i3] * h * fr;
      d[i3 + 1] += v[i3 + 1] * h * fr;
      d[i3 + 2] += v[i3 + 2] * h * fr;
      // never sink through the plate
      const y = rest[i3 + 1] + d[i3 + 1];
      if (y < 0.01) {
        d[i3 + 1] = 0.01 - rest[i3 + 1];
        if (v[i3 + 1] < 0) v[i3 + 1] *= -0.3;
      }
      energy += v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2];
    }
    this.energy = energy / n;

    const p = this.positions;
    for (let i = 0; i < n * 3; i++) p[i] = rest[i] + d[i];
    this.time += h;
  }
}

/** Area-weighted smooth vertex normals. Writes into `out`, returns it. */
export function computeNormals(positions, index, out) {
  out.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}
