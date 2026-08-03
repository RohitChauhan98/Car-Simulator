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
};

/**
 * Dust / gravel particle pool kicked up by wheel slip on loose surfaces.
 * External code calls `spawn` / `emitFromSources` / `update`.
 */
export class ParticleSystem {
  private mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private vel: Float32Array;
  private dummy = new THREE.Object3D();
  private next = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(0.08, 4, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc4b090,
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
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
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
    this.mesh.instanceMatrix.needsUpdate = true;
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
      this.spawn(
        w.position.x,
        w.position.y + 0.05,
        w.position.z,
        -carVel.x * 0.15 + (Math.random() - 0.5),
        0.5 + Math.random() * 1.2,
        -carVel.z * 0.15 + (Math.random() - 0.5),
        0.4 + Math.random() * 0.6,
      );
    }
  }

  /** @deprecated alias kept for main.ts compatibility */
  emitFromWheels(wheels: DustSource[], carVel: { x: number; z: number }) {
    this.emitFromSources(wheels, carVel);
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
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
