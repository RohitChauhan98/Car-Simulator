import type { RigidBody } from '@dimforge/rapier3d-compat';

export type HydroWheel = {
  worldPos: { x: number; y: number; z: number };
};

/**
 * Isolated water interaction: extra linear/angular drag when wheels or chassis
 * sit below the water surface. No buoyancy (avoids launching the car).
 */
export function applyHydrodynamics(
  body: RigidBody,
  wheels: HydroWheel[],
  wheelRadius: number,
  waterHeightAt: (x: number, z: number) => number,
  dt: number,
): number {
  const t = body.translation();
  const lv = body.linvel();
  const av = body.angvel();
  let maxDepth = 0;

  for (const w of wheels) {
    const surface = waterHeightAt(w.worldPos.x, w.worldPos.z);
    if (!Number.isFinite(surface)) continue;
    const depth = surface - (w.worldPos.y - wheelRadius * 0.85);
    if (depth <= 0) continue;
    maxDepth = Math.max(maxDepth, depth);
    const k = Math.min(1.2, depth) * 380;
    body.applyImpulse(
      {
        x: -lv.x * k * dt,
        y: -lv.y * k * 0.35 * dt,
        z: -lv.z * k * dt,
      },
      true,
    );
  }

  const chassisSurface = waterHeightAt(t.x, t.z);
  if (Number.isFinite(chassisSurface)) {
    const cdepth = chassisSurface - t.y;
    if (cdepth > -0.55) {
      const k = Math.min(1, Math.max(0, cdepth + 0.55));
      maxDepth = Math.max(maxDepth, cdepth);
      body.applyImpulse(
        {
          x: -lv.x * 720 * k * dt,
          y: -lv.y * 180 * k * dt,
          z: -lv.z * 720 * k * dt,
        },
        true,
      );
      body.applyTorqueImpulse(
        {
          x: -av.x * 55 * k * dt,
          y: -av.y * 40 * k * dt,
          z: -av.z * 55 * k * dt,
        },
        true,
      );
    }
  }

  return maxDepth;
}
