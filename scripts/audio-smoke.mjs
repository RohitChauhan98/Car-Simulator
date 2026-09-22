/**
 * Headless checks for vehicle-audio mapping curves.
 * Mirrors src/audio/mapping.ts (this script cannot import TS under node).
 * Run: node scripts/audio-smoke.mjs
 */
import assert from 'node:assert/strict';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function trap(x, a, b, c, d) {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / Math.max(1e-6, b - a);
  if (x <= c) return 1;
  return 1 - (x - c) / Math.max(1e-6, d - c);
}

function engineLayerWeights(rpm) {
  const r = Math.max(0, rpm);
  const raw = {
    idle: trap(r, -1, 0, 1500, 3000),
    low: trap(r, 0, 1500, 3000, 4500),
    mid: trap(r, 1500, 3000, 4500, 6000),
    high: trap(r, 3000, 4500, 6000, 7200),
    redline: trap(r, 4500, 6000, 9000, 12000),
  };
  let sum = 0;
  for (const k of Object.keys(raw)) sum += raw[k];
  if (sum < 1e-6) {
    raw.idle = 1;
    sum = 1;
  }
  for (const k of Object.keys(raw)) raw[k] /= sum;
  return raw;
}

function slipSkidGain(slip) {
  const s = Math.max(0, slip);
  if (s < 0.05) return 0;
  if (s < 0.2) return ((s - 0.05) / 0.15) * 0.25;
  if (s < 0.5) return 0.25 + ((s - 0.2) / 0.3) * 0.5;
  return Math.min(1, 0.75 + (s - 0.5) * 0.5);
}

function collisionIntensity(relSpeed, impulse, mass) {
  const fromSpeed = clamp01((relSpeed - 0.8) / 14);
  const fromImpulse = clamp01(impulse / (mass * 6 + 1));
  return clamp01(Math.max(fromSpeed, fromImpulse * 0.85));
}

const SURFACE_BY_ID = [
  'tarmac', 'dirt', 'gravel', 'scree', 'grass', 'rock', 'mud', 'water',
];

function surfaceTypeFromId(id) {
  return SURFACE_BY_ID[id] ?? 'tarmac';
}

function dominantSurface(wheels) {
  const counts = new Map();
  for (const w of wheels) {
    if (!w.grounded) continue;
    const s = surfaceTypeFromId(w.surfaceId);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = 'tarmac';
  let n = 0;
  for (const [s, c] of counts) {
    if (c > n) {
      best = s;
      n = c;
    }
  }
  return best;
}

// RPM bands
{
  const idle = engineLayerWeights(900);
  assert.ok(idle.idle > 0.6, 'idle dominant at 900');
  assert.ok(idle.mid < 0.05 && idle.high < 0.05);

  const mix = engineLayerWeights(2000);
  assert.ok(mix.idle > 0.2 && mix.low > 0.4, 'idle+low at 2000');

  const mid = engineLayerWeights(3750);
  assert.ok(mid.low > 0.15 && mid.mid > 0.4, 'low+mid at 3750');

  const hi = engineLayerWeights(5250);
  assert.ok(hi.mid > 0.1 && hi.high > 0.4, 'mid+high at 5250');

  const red = engineLayerWeights(6500);
  assert.ok(red.redline > 0.4 && red.high > 0.1, 'high/redline at 6500');

  const sum = Object.values(engineLayerWeights(4100)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, 'weights normalized');
}

// Slip curve
{
  assert.equal(slipSkidGain(0.02), 0);
  assert.ok(slipSkidGain(0.12) > 0 && slipSkidGain(0.12) < 0.25);
  assert.ok(slipSkidGain(0.35) > 0.25 && slipSkidGain(0.35) < 0.75);
  assert.ok(slipSkidGain(0.8) > 0.75);
}

function skidMotionGate(speedMs, omega, radius) {
  const motion = Math.max(Math.abs(speedMs), Math.abs(omega) * radius);
  return Math.max(0, Math.min(1, (motion - 3.2) / 5.5));
}

{
  assert.equal(skidMotionGate(0, 0, 0.48), 0);
  assert.equal(skidMotionGate(2.7, 0, 0.48), 0, 'no skid while creeping');
  assert.ok(skidMotionGate(12, 0, 0.48) > 0.9);
}

function audibleWheelSlip(opts) {
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

{
  const parked = audibleWheelSlip({
    slip: 1.02, slipLat: 0.01, speedMs: 2.7, omega: 6, radius: 0.48,
    brake: 0, throttle: 0, grounded: true,
  });
  assert.equal(parked, 0, 'idle Pacejka slip is silent');
  const spin = audibleWheelSlip({
    slip: 0.8, slipLat: 0.02, speedMs: 4, omega: 22, radius: 0.48,
    brake: 0, throttle: 0.8, grounded: true,
  });
  assert.ok(spin > 0.3, 'wheelspin is audible');
  const lock = audibleWheelSlip({
    slip: 0.6, slipLat: 0.05, speedMs: 12, omega: 4, radius: 0.48,
    brake: 0.9, throttle: 0, grounded: true,
  });
  assert.ok(lock > 0.3, 'brake lockup is audible');
}

// Collision normalize
{
  assert.ok(collisionIntensity(0.2, 0, 1350) < 0.05);
  const mid = collisionIntensity(6, 0, 1350);
  assert.ok(mid > 0.2 && mid < 0.7);
  assert.ok(collisionIntensity(20, 20000, 1350) > 0.85);
}

// Surface mapping
{
  assert.equal(surfaceTypeFromId(1), 'dirt');
  assert.equal(surfaceTypeFromId(6), 'mud');
  assert.equal(
    dominantSurface([
      { grounded: true, surfaceId: 1 },
      { grounded: true, surfaceId: 1 },
      { grounded: true, surfaceId: 4 },
      { grounded: false, surfaceId: 0 },
    ]),
    'dirt',
  );
}

console.log('AUDIO SMOKE OK');
