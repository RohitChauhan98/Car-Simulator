import * as THREE from 'three';
import { SURFACES } from '../config';

const POOL = 280;

/** Minimal wheel-like payload so callers can spawn dust without importing vehicle. */
export type DustSource = {
  grounded: boolean;
  surfaceId: number;
  slip: number;
  slipLat: number;
  position: { x: number; y: number; z: number };
  omega?: number;
};

const WATER_POOL = 180;

/**
 * Dust / gravel particle pool kicked up by wheel slip on loose surfaces,
 * plus a separate water-spray pool.
 */
export class ParticleSystem {
  private mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private vel: Float32Array;
  private dummy = new THREE.Object3D();
  private next = 0;
  private dustTint = new THREE.Color();

  private waterMesh: THREE.InstancedMesh;
  private waterLife: Float32Array;
  private waterVel: Float32Array;
  private waterNext = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(0.08, 4, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.mesh.count = POOL;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.life = new Float32Array(POOL);
    this.vel = new Float32Array(POOL * 3);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    const dustCol = new THREE.Color(0xc4b090);
    for (let i = 0; i < POOL; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, dustCol);
    }

    const wgeo = new THREE.SphereGeometry(0.07, 4, 3);
    const wmat = new THREE.MeshBasicMaterial({
      color: 0xc8e8ee,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.waterMesh = new THREE.InstancedMesh(wgeo, wmat, WATER_POOL);
    this.waterMesh.count = WATER_POOL;
    this.waterMesh.frustumCulled = false;
    scene.add(this.waterMesh);
    this.waterLife = new Float32Array(WATER_POOL);
    this.waterVel = new Float32Array(WATER_POOL * 3);
    for (let i = 0; i < WATER_POOL; i++) this.waterMesh.setMatrixAt(i, this.dummy.matrix);
  }

  /** Public spawn API for external emitters (one dust puff). */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life = 0.6,
    tint = 0xc4b090,
  ) {
    const i = this.next++ % POOL;
    this.life[i] = life;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.dummy.position.set(x, y, z);
    this.dummy.scale.setScalar(0.6 + Math.random());
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.setColorAt(i, this.dustTint.setHex(tint));
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Emit from wheel-like sources based on surface dust factor + slip. */
  emitFromSources(sources: DustSource[], carVel: { x: number; z: number }) {
    for (const w of sources) {
      if (!w.grounded) continue;
      const surf = SURFACES[w.surfaceId] ?? SURFACES[1];
      const slip = Math.max(w.slip, w.slipLat * 0.5);
      if (surf.dust < 0.2 || slip < 0.12) continue;
      const rate = surf.dust * slip * 3;
      if (Math.random() > rate * 0.15) continue;
      const tint = w.surfaceId === 6 ? 0x4a3424 : w.surfaceId === 2 ? 0xb8a070 : 0xc4b090;
      this.spawn(
        w.position.x,
        w.position.y + 0.05,
        w.position.z,
        -carVel.x * 0.15 + (Math.random() - 0.5),
        0.5 + Math.random() * 1.2,
        -carVel.z * 0.15 + (Math.random() - 0.5),
        0.4 + Math.random() * 0.6,
        tint,
      );
    }
  }

  /** @deprecated alias kept for main.ts compatibility */
  emitFromWheels(wheels: DustSource[], carVel: { x: number; z: number }) {
    this.emitFromSources(wheels, carVel);
  }

  spawnWater(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, scale: number,
  ) {
    const i = this.waterNext++ % WATER_POOL;
    this.waterLife[i] = life;
    this.waterVel[i * 3] = vx;
    this.waterVel[i * 3 + 1] = vy;
    this.waterVel[i * 3 + 2] = vz;
    this.dummy.position.set(x, y, z);
    this.dummy.scale.setScalar(scale);
    this.dummy.updateMatrix();
    this.waterMesh.setMatrixAt(i, this.dummy.matrix);
    this.waterMesh.instanceMatrix.needsUpdate = true;
  }

  /** Speed-scaled wheel spray when a wheel is in a water patch. */
  emitWater(
    sources: DustSource[],
    carVel: { x: number; z: number },
    waterHeightAt: (x: number, z: number) => number,
  ) {
    const speed = Math.hypot(carVel.x, carVel.z);
    for (const w of sources) {
      const surface = waterHeightAt(w.position.x, w.position.z);
      const inWater = Number.isFinite(surface) && (w.position.y - 0.4) < surface + 0.15;
      if (!inWater && w.surfaceId !== 7) continue;
      const intensity = Math.min(1.2, speed / 9 + Math.abs(w.omega ?? 0) * 0.004);
      if (intensity < 0.08) {
        if (Math.random() < 0.12) {
          this.spawnWater(
            w.position.x + (Math.random() - 0.5) * 0.25,
            (Number.isFinite(surface) ? surface : w.position.y) + 0.04,
            w.position.z + (Math.random() - 0.5) * 0.25,
            (Math.random() - 0.5) * 0.4,
            0.4 + Math.random() * 0.5,
            (Math.random() - 0.5) * 0.4,
            0.28 + Math.random() * 0.2,
            0.25 + Math.random() * 0.25,
          );
        }
        continue;
      }
      const n = intensity > 0.55 ? 2 + ((Math.random() * 3) | 0) : 1;
      for (let k = 0; k < n; k++) {
        const side = (Math.random() - 0.5);
        this.spawnWater(
          w.position.x + side * 0.4,
          (Number.isFinite(surface) ? surface : w.position.y) + 0.06,
          w.position.z + (Math.random() - 0.5) * 0.35,
          -carVel.x * (0.2 + intensity * 0.45) + side * (1.2 + intensity * 2.4),
          0.8 + intensity * (2.2 + Math.random() * 2.5),
          -carVel.z * (0.2 + intensity * 0.45) + (Math.random() - 0.5) * (1.2 + intensity * 2),
          0.35 + intensity * 0.45 + Math.random() * 0.25,
          0.35 + intensity * 0.7 + Math.random() * 0.4,
        );
      }
    }
  }

  update(dt: number) {
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.matrix.decompose(
        this.dummy.position,
        this.dummy.quaternion,
        this.dummy.scale,
      );
      this.dummy.position.x += this.vel[i * 3] * dt;
      this.dummy.position.y += this.vel[i * 3 + 1] * dt;
      this.dummy.position.z += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 4 * dt;
      if (this.life[i] <= 0) this.dummy.scale.set(0, 0, 0);
      else this.dummy.scale.multiplyScalar(0.985);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;

    let wdirty = false;
    for (let i = 0; i < WATER_POOL; i++) {
      if (this.waterLife[i] <= 0) continue;
      this.waterLife[i] -= dt;
      this.waterMesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.matrix.decompose(
        this.dummy.position,
        this.dummy.quaternion,
        this.dummy.scale,
      );
      this.dummy.position.x += this.waterVel[i * 3] * dt;
      this.dummy.position.y += this.waterVel[i * 3 + 1] * dt;
      this.dummy.position.z += this.waterVel[i * 3 + 2] * dt;
      this.waterVel[i * 3 + 1] -= 9 * dt;
      if (this.waterLife[i] <= 0) this.dummy.scale.set(0, 0, 0);
      else this.dummy.scale.multiplyScalar(0.97);
      this.dummy.updateMatrix();
      this.waterMesh.setMatrixAt(i, this.dummy.matrix);
      wdirty = true;
    }
    if (wdirty) this.waterMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.waterMesh.removeFromParent();
    this.waterMesh.geometry.dispose();
    (this.waterMesh.material as THREE.Material).dispose();
  }
}
