import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { collisionIntensity, scrapeGain, hypot3 } from '../audio/mapping';
import type { CollisionMaterial, Vec3 } from '../audio/types';
import { colliderMaterial } from './materials';

export type ChassisContact = {
  otherHandle: number;
  intensity: number;
  position: Vec3;
  direction: Vec3;
  material: CollisionMaterial;
  tangentialSpeed: number;
  relativeSpeed: number;
  impulse: number;
  started: boolean;
  /** True when intensity jumped vs last step for this collider. */
  spiked: boolean;
  scrape: number;
};

function quatRotate(
  q: { x: number; y: number; z: number; w: number },
  v: Vec3,
): Vec3 {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

function localToWorld(
  collider: Collider,
  local: { x: number; y: number; z: number },
): Vec3 {
  const t = collider.translation();
  const r = collider.rotation();
  const w = quatRotate(r, local);
  return { x: t.x + w.x, y: t.y + w.y, z: t.z + w.z };
}

/**
 * Reads Rapier contact manifolds on the chassis collider after world.step().
 * Does not change vehicle dynamics.
 */
export class ChassisContactProbe {
  private prev = new Set<number>();
  private lastIntensity = new Map<number, number>();

  poll(
    world: World,
    chassis: Collider,
    body: RigidBody,
    mass: number,
  ): ChassisContact[] {
    const out: ChassisContact[] = [];
    const seen = new Set<number>();
    const lv = body.linvel();

    world.contactPairsWith(chassis, (other) => {
      if (other.handle === chassis.handle) return;
      seen.add(other.handle);

      let bestImpulse = 0;
      let point: Vec3 = body.translation();
      let normal: Vec3 = { x: 0, y: 1, z: 0 };
      let tangentSpeed = 0;
      let found = false;
      let manifolds = 0;

      world.contactPair(chassis, other, (manifold, flipped) => {
        manifolds++;
        const nSolved = manifold.numSolverContacts();
        if (nSolved > 0) {
          const sp = manifold.solverContactPoint(0);
          if (sp) {
            point = { x: sp.x, y: sp.y, z: sp.z };
            found = true;
          }
          const tv = manifold.solverContactTangentVelocity(0);
          if (tv) tangentSpeed = Math.max(tangentSpeed, Math.hypot(tv.x, tv.y, tv.z));
        }
        const nrm = manifold.normal();
        if (nrm) {
          normal = flipped
            ? { x: -nrm.x, y: -nrm.y, z: -nrm.z }
            : { x: nrm.x, y: nrm.y, z: nrm.z };
        }
        const n = manifold.numContacts();
        for (let i = 0; i < n; i++) {
          const imp = Math.abs(manifold.contactImpulse(i));
          if (imp >= bestImpulse) {
            bestImpulse = imp;
            if (!found) {
              const lp = flipped
                ? manifold.localContactPoint2(i)
                : manifold.localContactPoint1(i);
              if (lp) {
                point = localToWorld(flipped ? other : chassis, lp);
                found = true;
              }
            }
          }
        }
      });

      if (!manifolds) return;

      const otherBody = other.parent();
      const ov = otherBody ? otherBody.linvel() : { x: 0, y: 0, z: 0 };
      const rel: Vec3 = { x: lv.x - ov.x, y: lv.y - ov.y, z: lv.z - ov.z };
      const relativeSpeed = hypot3(rel);
      const intensity = collisionIntensity(relativeSpeed, bestImpulse, mass);
      const started = !this.prev.has(other.handle);
      const prevI = this.lastIntensity.get(other.handle) ?? 0;
      const spiked = intensity - prevI > 0.25;
      const material = colliderMaterial(other);
      const scrape = scrapeGain(Math.max(tangentSpeed, relativeSpeed * 0.65), bestImpulse);

      out.push({
        otherHandle: other.handle,
        intensity,
        position: point,
        direction: normal,
        material,
        tangentialSpeed: Math.max(tangentSpeed, relativeSpeed * 0.65),
        relativeSpeed,
        impulse: bestImpulse,
        started,
        spiked,
        scrape,
      });
      this.lastIntensity.set(other.handle, intensity);
    });

    this.prev = seen;
    for (const h of [...this.lastIntensity.keys()]) {
      if (!seen.has(h)) this.lastIntensity.delete(h);
    }
    return out;
  }
}
