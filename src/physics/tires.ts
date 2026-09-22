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
 *
 * Longitudinal slip used for *force* is soft-capped: full-throttle 1st on a
 * grade easily produces slip ratios ≫ 1 (wheelspin). Uncapped Pacejka with
 * C>1 rides the falling flank and leaves ~¼ peak Fx — looks like "no traction"
 * despite high RPM. Cap keeps push near peak μ while real slip still drives FX.
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

  const cap = TIRES.longSlipForceCap;
  const slipForFx =
    Math.abs(slipRatio) <= cap
      ? slipRatio
      : Math.sign(slipRatio) * cap;

  let Fx = pacejka(slipForFx, TIRES.longB, TIRES.longC, D);
  let Fy = -pacejka(slipAngle, TIRES.latB, TIRES.latC, D);

  // Friction ellipse: scale if combined demand exceeds peak
  const combined = Math.hypot(Fx, Fy);
  if (combined > D && combined > 1e-6) {
    const s = D / combined;
    Fx *= s;
    Fy *= s;
  }

  // Low-speed blend: slip-ratio Pacejka is ill-conditioned near zero speed, so
  // we mix in a grip-limited damper. Scale so |slip|==cap → ±D (same region as
  // the Pacejka peak). The old `slip * load * 0.35` only reached ~10% of D at
  // crawl — 1st gear revs high but the car couldn't climb.
  const absV = Math.abs(speedMs);
  if (absV < TIRES.lowSpeedBlend) {
    const blend = absV / TIRES.lowSpeedBlend;
    const viscLong = Math.max(-D, Math.min(D, (slipForFx / Math.max(1e-6, cap)) * D));
    // Lateral: match Pacejka sign (Fy = -pacejka(slipAngle, ...))
    const latCap = 0.35; // rad ≈ peak slip-angle region
    const ang = Math.max(-latCap, Math.min(latCap, slipAngle));
    const viscLat = Math.max(-D, Math.min(D, -(ang / latCap) * D));
    Fx = Fx * blend + viscLong * (1 - blend);
    Fy = Fy * blend + viscLat * (1 - blend);
    const comb2 = Math.hypot(Fx, Fy);
    if (comb2 > D && comb2 > 1e-6) {
      const s = D / comb2;
      Fx *= s;
      Fy *= s;
    }
  }

  return { long: Fx, lat: Fy, slipRatio, slipAngle };
}

export function surfaceGrip(surfaceId: number): number {
  return (SURFACES[surfaceId] ?? SURFACES[1]).grip;
}

export function surfaceRolling(surfaceId: number): number {
  return (SURFACES[surfaceId] ?? SURFACES[1]).rolling;
}
