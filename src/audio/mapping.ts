import { ENGINE, SURFACES } from '../config';
import type {
  EngineLayerId,
  EngineLoadMode,
  SurfaceType,
  Vec3,
} from './types';

export const ENGINE_LAYERS: EngineLayerId[] = [
  'idle',
  'low',
  'mid',
  'high',
  'redline',
];

export const SURFACE_TYPES: SurfaceType[] = [
  'tarmac',
  'dirt',
  'gravel',
  'scree',
  'grass',
  'rock',
  'mud',
  'water',
];

const SURFACE_BY_ID: SurfaceType[] = [
  'tarmac',
  'dirt',
  'gravel',
  'scree',
  'grass',
  'rock',
  'mud',
  'water',
];

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function hypot3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Trapezoid: 0 before a, rise a→b, 1 on [b,c], fall c→d, 0 after d. */
export function trap(x: number, a: number, b: number, c: number, d: number): number {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / Math.max(1e-6, b - a);
  if (x <= c) return 1;
  return 1 - (x - c) / Math.max(1e-6, d - c);
}

export function surfaceTypeFromId(id: number): SurfaceType {
  const named = (SURFACES[id] ?? SURFACES[0]).name;
  if ((SURFACE_TYPES as string[]).includes(named)) return named as SurfaceType;
  return SURFACE_BY_ID[id] ?? 'tarmac';
}

export function dominantSurface(
  wheels: { grounded: boolean; surfaceId: number }[],
): SurfaceType {
  const counts = new Map<SurfaceType, number>();
  for (const w of wheels) {
    if (!w.grounded) continue;
    const s = surfaceTypeFromId(w.surfaceId);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: SurfaceType = 'tarmac';
  let n = 0;
  for (const [s, c] of counts) {
    if (c > n) {
      best = s;
      n = c;
    }
  }
  return best;
}

/**
 * Overlapping RPM crossfade. Bands match the design:
 * 0–1500 idle, 1500–3000 idle+low, 3000–4500 low+mid,
 * 4500–6000 mid+high, 6000+ high/redline.
 */
export function engineLayerWeights(rpm: number): Record<EngineLayerId, number> {
  const r = Math.max(0, rpm);
  const raw: Record<EngineLayerId, number> = {
    idle: trap(r, -1, 0, 1500, 3000),
    low: trap(r, 0, 1500, 3000, 4500),
    mid: trap(r, 1500, 3000, 4500, 6000),
    high: trap(r, 3000, 4500, 6000, 7200),
    redline: trap(r, 4500, 6000, 9000, 12000),
  };
  let sum = 0;
  for (const k of ENGINE_LAYERS) sum += raw[k];
  if (sum < 1e-6) {
    raw.idle = 1;
    sum = 1;
  }
  for (const k of ENGINE_LAYERS) raw[k] /= sum;
  return raw;
}

export function normalizedRPM(rpm: number): number {
  const span = Math.max(1, ENGINE.redlineRPM - ENGINE.idleRPM);
  return clamp01((rpm - ENGINE.idleRPM) / span);
}

export function normalizedSpeed(speedMs: number, ref = 42): number {
  return clamp01(Math.abs(speedMs) / ref);
}

export function layerPlaybackRate(rpm: number, baseRpm: number): number {
  return Math.max(0.55, Math.min(1.85, rpm / Math.max(1, baseRpm)));
}

export function slipSkidGain(slip: number): number {
  const s = Math.max(0, slip);
  if (s < 0.05) return 0;
  if (s < 0.2) return ((s - 0.05) / 0.15) * 0.25;
  if (s < 0.5) return 0.25 + ((s - 0.2) / 0.3) * 0.5;
  return Math.min(1, 0.75 + (s - 0.5) * 0.5);
}

/**
 * Pacejka slip ratio is ill-defined at crawl and will "skid" while parked.
 * Only keep slip that is actually wheelspin, lockup, or a moving slide.
 */
export function audibleWheelSlip(opts: {
  slip: number;
  slipLat: number;
  speedMs: number;
  omega: number;
  radius: number;
  brake: number;
  throttle: number;
  grounded: boolean;
}): number {
  if (!opts.grounded) return 0;
  const v = Math.abs(opts.speedMs);
  const wheel = Math.abs(opts.omega) * opts.radius;
  const spin = Math.max(0, wheel - v);
  const lock = Math.max(0, v - wheel);
  const spinning = spin > 2.2 && opts.throttle > 0.1;
  const locking = lock > 1.5 && opts.brake > 0.16;
  const sliding = v > 6 && (opts.slip > 0.22 || opts.slipLat > 0.16);
  if (!spinning && !locking && !sliding) return 0;
  if (spinning) return Math.max(opts.slip, spin / 7);
  if (locking) return Math.max(opts.slip, lock / 5.5);
  return Math.max(opts.slip, opts.slipLat);
}

/** Standstill Pacejka slip is noisy; require real motion (speed or wheel spin). */
export function skidMotionGate(speedMs: number, omega: number, radius: number): number {
  const motion = Math.max(Math.abs(speedMs), Math.abs(omega) * radius);
  return clamp01((motion - 3.2) / 5.5);
}

export function rollingGain(
  speedMs: number,
  omega: number,
  radius: number,
  grounded: boolean,
): number {
  if (!grounded) return 0;
  const wheelSpeed = Math.abs(omega) * radius;
  const v = Math.max(Math.abs(speedMs), wheelSpeed);
  return clamp01((v - 0.55) / 22);
}

export function collisionIntensity(
  relSpeed: number,
  impulse: number,
  mass: number,
): number {
  const fromSpeed = clamp01((relSpeed - 0.8) / 14);
  const fromImpulse = clamp01(impulse / (mass * 6 + 1));
  return clamp01(Math.max(fromSpeed, fromImpulse * 0.85));
}

export function scrapeGain(tangentialSpeed: number, impulse: number): number {
  const fromSpeed = clamp01((tangentialSpeed - 1.2) / 10);
  const fromForce = clamp01(impulse / 800);
  return fromSpeed * (0.35 + 0.65 * Math.max(fromForce, 0.2));
}

export function brakeMechanicalGain(
  brake: number,
  speedMs: number,
  skidGain: number,
  grounded: boolean,
): number {
  if (!grounded) return 0;
  const v = Math.abs(speedMs);
  if (v < 0.7 || brake < 0.04) return 0;
  const moving = clamp01((v - 0.7) / 6);
  return clamp01(brake) * moving * (1 - skidGain * 0.8);
}

export function isAsphaltLike(s: SurfaceType): boolean {
  return s === 'tarmac';
}

export function skidCharacter(s: SurfaceType): 'squeal' | 'grit' {
  return isAsphaltLike(s) ? 'squeal' : 'grit';
}

export function engineLoadMode(opts: {
  throttle: number;
  rpm: number;
  speedMs: number;
  gear: number;
  clutchLocked: boolean;
  engineLoad: number;
}): EngineLoadMode {
  const { throttle, rpm, speedMs, gear, clutchLocked, engineLoad } = opts;
  if (throttle < 0.06) {
    if (
      clutchLocked &&
      gear !== 0 &&
      rpm > ENGINE.idleRPM + 350 &&
      Math.abs(speedMs) > 2
    ) {
      return 'engineBrake';
    }
    if (Math.abs(speedMs) > 3 && rpm > ENGINE.idleRPM + 180) return 'coast';
    return 'idle';
  }
  if (throttle > 0.82 || engineLoad > 0.85) return 'full';
  if (throttle > 0.4 || engineLoad > 0.5) return 'medium';
  return 'light';
}

/** Load-driven intensity 0..1 used as engine aggression. */
export function engineAggression(
  loadMode: EngineLoadMode,
  throttle: number,
  engineLoad: number,
): number {
  const base =
    loadMode === 'full' ? 1
    : loadMode === 'medium' ? 0.62
    : loadMode === 'light' ? 0.32
    : loadMode === 'engineBrake' ? 0.28
    : loadMode === 'coast' ? 0.18
    : 0.12;
  return clamp01(Math.max(base, throttle * 0.7 + engineLoad * 0.45));
}

export const LAYER_BASE_RPM: Record<EngineLayerId, number> = {
  idle: 900,
  low: 2200,
  mid: 3750,
  high: 5250,
  redline: 6500,
};
