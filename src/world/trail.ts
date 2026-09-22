import * as THREE from 'three';
import { CHASSIS } from '../config';

export type TrailKind =
  | 'dirt'
  | 'climb'
  | 'rocks'
  | 'narrow'
  | 'water'
  | 'steep'
  | 'logs'
  | 'descent'
  | 'mud';

export type TrailSample = {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  width: number;
  surface: number;
  kind: TrailKind;
  t: number;
};

export type TrailInfluence = {
  dist: number;
  width: number;
  surface: number;
  heightHint: number;
  kind: TrailKind;
  t: number;
};

type InflSample = {
  x: number;
  y: number;
  z: number;
  width: number;
  surface: number;
  kind: TrailKind;
  t: number;
};

type Section = {
  t0: number;
  t1: number;
  kind: TrailKind;
  width: number;
  surface: number;
};

const SECTIONS: Section[] = [
  { t0: 0.00, t1: 0.10, kind: 'dirt', width: 7.0, surface: 1 },
  { t0: 0.10, t1: 0.18, kind: 'climb', width: 6.6, surface: 1 },
  { t0: 0.18, t1: 0.26, kind: 'water', width: 8.2, surface: 7 },
  { t0: 0.26, t1: 0.38, kind: 'rocks', width: 7.0, surface: 5 },
  { t0: 0.38, t1: 0.48, kind: 'narrow', width: 5.0, surface: 2 },
  { t0: 0.48, t1: 0.58, kind: 'water', width: 9.2, surface: 7 },
  { t0: 0.58, t1: 0.70, kind: 'steep', width: 6.4, surface: 2 },
  { t0: 0.70, t1: 0.78, kind: 'logs', width: 7.0, surface: 1 },
  { t0: 0.78, t1: 0.88, kind: 'descent', width: 7.2, surface: 5 },
  { t0: 0.88, t1: 1.01, kind: 'mud', width: 8.2, surface: 6 },
];

/**
 * Authored jungle dirt trail: forest dirt → climb → early creek → rocks →
 * narrow gravel → main water → steep gravel → logs → rocky descent → mud.
 */
export class TrailNetwork {
  curve: THREE.CatmullRomCurve3;
  length: number;
  private inflCache: InflSample[] = [];

  constructor() {
    const pts: THREE.Vector3[] = [
      new THREE.Vector3(CHASSIS.spawn.x, 24, CHASSIS.spawn.z),
      new THREE.Vector3(-400, 25, 40),
      new THREE.Vector3(-320, 26, 78),
      new THREE.Vector3(-240, 28, 52),
      new THREE.Vector3(-170, 38, 8),
      new THREE.Vector3(-108, 46, -36),
      new THREE.Vector3(-42, 50, -86),
      new THREE.Vector3(28, 52, -118),
      new THREE.Vector3(88, 48, -72),
      new THREE.Vector3(128, 42, -8),
      new THREE.Vector3(152, 32, 56),
      new THREE.Vector3(176, 24, 102),
      new THREE.Vector3(214, 25, 138),
      new THREE.Vector3(258, 32, 152),
      new THREE.Vector3(302, 50, 118),
      new THREE.Vector3(338, 68, 64),
      new THREE.Vector3(362, 74, 16),
      new THREE.Vector3(392, 68, -46),
      new THREE.Vector3(432, 50, -86),
      new THREE.Vector3(474, 36, -48),
      new THREE.Vector3(512, 28, 14),
      new THREE.Vector3(548, 26, 68),
    ];
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.28);
    this.length = this.curve.getLength();
    this.buildInfluenceCache(420);
  }

  sectionAt(t: number): Section {
    const u = Math.max(0, Math.min(1, t));
    for (const s of SECTIONS) {
      if (u >= s.t0 && u < s.t1) return s;
    }
    return SECTIONS[SECTIONS.length - 1];
  }

  private buildInfluenceCache(count: number) {
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = this.curve.getPoint(t);
      const sec = this.sectionAt(t);
      this.inflCache.push({
        x: p.x, y: p.y, z: p.z,
        width: sec.width,
        surface: sec.surface,
        kind: sec.kind,
        t,
      });
    }
  }

  influenceAt(x: number, z: number): TrailInfluence {
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
      kind: best.kind,
      t: best.t,
    };
  }

  sample(count: number): TrailSample[] {
    const out: TrailSample[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      const position = this.curve.getPoint(t);
      const tangent = this.curve.getTangent(t).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      const sec = this.sectionAt(t);
      out.push({
        position, tangent, normal,
        width: sec.width,
        surface: sec.surface,
        kind: sec.kind,
        t,
      });
    }
    return out;
  }

  samplesOf(kind: TrailKind, count = 24): TrailSample[] {
    return this.sample(count * 4).filter((s) => s.kind === kind);
  }

  spawnPoint(): THREE.Vector3 {
    return this.curve.getPoint(0.018);
  }

  spawnYaw(): number {
    const t = this.curve.getTangent(0.018);
    return Math.atan2(-t.x, -t.z);
  }
}

/** Back-compat alias so older imports keep compiling. */
export { TrailNetwork as RoadNetwork };
