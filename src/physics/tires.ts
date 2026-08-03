import { SURFACES, TIRES } from '../config';

export type TireForce = {
  long: number; // longitudinal force in tire forward dir, N
  lat: number;  // lateral force, N
  slipRatio: number;
  slipAngle: number;
};

function pacejka(slip: number, B: number, C: number, D: number): number {
  return D * Math.sin(C * Math.atan(B * slip));
}

/**
 * Simplified Pacejka + friction circle, with low-speed viscous blend for
 * numerical stability when the slip-ratio denominator would blow up.
 */
export function tireForces(
  slipRatio: number,
  slipAngle: number,
  loadN: number,
  surfaceId: number,
  speedMs: number,
): TireForce {
  const surf = SURFACES[surfaceId] ?? SURFACES[1];
  const load = Math.max(0, loadN);
  // load sensitivity gently reduces peak μ under high load
  const muPeak = surf.grip * (1 - TIRES.loadSensitivity * load);
  const D = muPeak * load;

  let Fx = pacejka(slipRatio, TIRES.longB, TIRES.longC, D);
  let Fy = -pacejka(slipAngle, TIRES.latB, TIRES.latC, D);

  // Friction ellipse: scale if combined demand exceeds peak
  const combined = Math.hypot(Fx, Fy);
  if (combined > D && combined > 1e-6) {
    const s = D / combined;
    Fx *= s;
    Fy *= s;
  }

  // Low-speed viscous blend toward a damping model.
  // Longitudinal: same sign as Pacejka — positive slip (wheel faster than road)
  // must push the car forward. (A leading minus here inverted drive at crawl.)
  const absV = Math.abs(speedMs);
  if (absV < TIRES.lowSpeedBlend) {
    const blend = absV / TIRES.lowSpeedBlend;
    const viscLong = slipRatio * load * 0.35;
    // Lateral: match Pacejka sign (Fy = -pacejka(slipAngle, ...))
    const viscLat = -slipAngle * load * 0.45;
    Fx = Fx * blend + viscLong * (1 - blend);
    Fy = Fy * blend + viscLat * (1 - blend);
  }

  return { long: Fx, lat: Fy, slipRatio, slipAngle };
}

export function surfaceGrip(surfaceId: number): number {
  return (SURFACES[surfaceId] ?? SURFACES[1]).grip;
}

export function surfaceRolling(surfaceId: number): number {
  return (SURFACES[surfaceId] ?? SURFACES[1]).rolling;
}
