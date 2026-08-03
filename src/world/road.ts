import * as THREE from 'three';
import { WORLD, CHASSIS } from '../config';

export type RoadSample = {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3; // yaw-plane right
  width: number;
  surface: number; // 0 tarmac, 2 gravel for branch
  t: number;
};

type InflSample = {
  x: number;
  y: number;
  z: number;
  width: number;
  surface: number;
};

/**
 * Catmull-Rom main road through the valley: floor → switchbacks → high point →
 * steep descent, plus a gravel off-road branch. Fitted to WORLD.size / valleyLineZ.
 */
export class RoadNetwork {
  main: THREE.CatmullRomCurve3;
  branch: THREE.CatmullRomCurve3;
  mainLength: number;
  branchLength: number;

  /** Dense XY samples for fast influence queries during heightmap carve. */
  private inflCache: InflSample[] = [];

  constructor() {
    const half = WORLD.size * 0.5;
    const vz = WORLD.valleyLineZ;

    // Control points in XZ; Y is a soft guide (terrain carving uses lateral falloff).
    // Start near CHASSIS.spawn on the valley floor.
    const mainPts: THREE.Vector3[] = [
      new THREE.Vector3(CHASSIS.spawn.x, 12, CHASSIS.spawn.z),
      new THREE.Vector3(-420, 14, vz),
      new THREE.Vector3(-280, 18, vz + 8),
      new THREE.Vector3(-160, 28, vz - 12),
      // first switchback hairpin
      new THREE.Vector3(-80, 55, vz - 90),
      new THREE.Vector3(-20, 72, vz - 40),
      new THREE.Vector3(40, 95, vz - 110),
      new THREE.Vector3(100, 118, vz - 35),
      new THREE.Vector3(160, 145, vz - 100),
      // high point / pass
      new THREE.Vector3(240, 195, vz - 60),
      new THREE.Vector3(320, 210, vz - 20),
      // steep descent
      new THREE.Vector3(400, 160, vz + 40),
      new THREE.Vector3(470, 95, vz + 70),
      new THREE.Vector3(half - 80, 40, vz + 30),
      new THREE.Vector3(half - 30, 28, vz),
    ];

    this.main = new THREE.CatmullRomCurve3(mainPts, false, 'catmullrom', 0.35);
    this.mainLength = this.main.getLength();

    // Gravel branch leaving near mid switchbacks toward river / off-road
    const branchPts: THREE.Vector3[] = [
      new THREE.Vector3(40, 95, vz - 110),
      new THREE.Vector3(90, 88, vz - 160),
      new THREE.Vector3(150, 70, vz - 200),
      new THREE.Vector3(220, 55, WORLD.riverZ - 30),
      new THREE.Vector3(280, 48, WORLD.riverZ + 10),
      new THREE.Vector3(340, 42, WORLD.riverZ - 20),
    ];
    this.branch = new THREE.CatmullRomCurve3(branchPts, false, 'catmullrom', 0.4);
    this.branchLength = this.branch.getLength();

    this.buildInfluenceCache(320, 7.5, 0, this.main);
    this.buildInfluenceCache(160, 5.5, 2, this.branch);
  }

  private buildInfluenceCache(
    count: number,
    width: number,
    surface: number,
    curve: THREE.CatmullRomCurve3,
  ) {
    for (let i = 0; i <= count; i++) {
      const p = curve.getPoint(i / count);
      this.inflCache.push({ x: p.x, y: p.y, z: p.z, width, surface });
    }
  }

  /** Closest road sample near (x,z) — for carving & surface assignment. */
  influenceAt(x: number, z: number): {
    dist: number;
    width: number;
    surface: number;
    heightHint: number;
  } {
    let bestDist = 1e9;
    let best = this.inflCache[0];
    for (let i = 0; i < this.inflCache.length; i++) {
      const s = this.inflCache[i];
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return {
      dist: bestDist,
      width: best.width,
      surface: best.surface,
      heightHint: best.y,
    };
  }

  /** Evenly spaced samples for props / guardrails. */
  sampleMain(count: number): RoadSample[] {
    return this.sampleCurve(this.main, count, 7.5, 0);
  }

  sampleBranch(count: number): RoadSample[] {
    return this.sampleCurve(this.branch, count, 5.5, 2);
  }

  private sampleCurve(
    curve: THREE.CatmullRomCurve3,
    count: number,
    width: number,
    surface: number,
  ): RoadSample[] {
    const out: RoadSample[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      const position = curve.getPoint(t);
      const tangent = curve.getTangent(t).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      out.push({ position, tangent, normal, width, surface, t });
    }
    return out;
  }

  /** Spawn point at start of main road (matches CHASSIS.spawn xz). */
  spawnPoint(): THREE.Vector3 {
    return this.main.getPoint(0.02);
  }

  /**
   * Forward yaw (radians) at spawn along road tangent in XZ.
   * Chassis forward is local -Z (not Three.js default +Z), so yaw is
   * atan2(-tx, -tz) so local -Z aligns with the curve tangent.
   */
  spawnYaw(): number {
    const t = this.main.getTangent(0.02);
    return Math.atan2(-t.x, -t.z);
  }
}
