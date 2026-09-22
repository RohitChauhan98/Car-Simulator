/** Vertical capsule occluders hashed in XZ for camera collision (trees, rocks, logs). */

export type Occluder = {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
};

function key(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

/**
 * Uniform-grid spatial hash of vertical capsules.
 * Camera rays query nearby cells instead of testing every tree.
 */
export class OcclusionHash {
  readonly items: Occluder[] = [];
  private readonly buckets = new Map<string, Occluder[]>();

  constructor(private readonly cellSize = 18) {}

  clear() {
    this.items.length = 0;
    this.buckets.clear();
  }

  insert(o: Occluder) {
    this.items.push(o);
    const pad = Math.max(1, Math.ceil(o.radius / this.cellSize));
    const cx = Math.floor(o.x / this.cellSize);
    const cz = Math.floor(o.z / this.cellSize);
    for (let iz = cz - pad; iz <= cz + pad; iz++) {
      for (let ix = cx - pad; ix <= cx + pad; ix++) {
        const k = key(ix, iz);
        let bin = this.buckets.get(k);
        if (!bin) {
          bin = [];
          this.buckets.set(k, bin);
        }
        bin.push(o);
      }
    }
  }

  /**
   * First hit distance along a ray, or null.
   * Capsules stand on (x, y, z) and rise along +Y.
   */
  cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): number | null {
    const steps = Math.max(1, Math.ceil(maxDist / this.cellSize));
    const seen = new Set<Occluder>();
    let best: number | null = null;

    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * maxDist;
      const px = ox + dx * t;
      const pz = oz + dz * t;
      const bin = this.buckets.get(key(Math.floor(px / this.cellSize), Math.floor(pz / this.cellSize)));
      if (!bin) continue;
      for (const o of bin) {
        if (seen.has(o)) continue;
        seen.add(o);
        const hit = rayCapsule(ox, oy, oz, dx, dy, dz, maxDist, o);
        if (hit !== null && (best === null || hit < best)) best = hit;
      }
    }
    return best;
  }
}

function rayCapsule(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  o: Occluder,
): number | null {
  const r = o.radius;
  const y0 = o.y;
  const y1 = o.y + o.height;
  // Infinite vertical cylinder in XZ, then clamp Y to the shaft (+ end caps as spheres).
  const fx = ox - o.x;
  const fz = oz - o.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const hits: number[] = [];

  if (a > 1e-8) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t0 = (-b - s) / (2 * a);
      const t1 = (-b + s) / (2 * a);
      for (const t of [t0, t1]) {
        if (t > 0.02 && t < maxDist) {
          const y = oy + dy * t;
          if (y >= y0 && y <= y1) hits.push(t);
        }
      }
    }
  }

  sphereHits(ox, oy, oz, dx, dy, dz, maxDist, o.x, y0, o.z, r, hits);
  sphereHits(ox, oy, oz, dx, dy, dz, maxDist, o.x, y1, o.z, r, hits);

  if (hits.length === 0) return null;
  let min = hits[0];
  for (let i = 1; i < hits.length; i++) if (hits[i] < min) min = hits[i];
  return min;
}

function sphereHits(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  cx: number, cy: number, cz: number,
  r: number,
  out: number[],
) {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-10) return;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / (2 * a);
  if (t0 > 0.02 && t0 < maxDist) out.push(t0);
}
