/**
 * Headless smoke checks for drive torque sign, dump-clutch stall,
 * engaged-clutch rollback resistance, and 1st-gear torque magnitude.
 * Mirrors src/physics engine/clutch/tire low-speed longitudinal sign.
 * Run: node scripts/powertrain-smoke.mjs
 */
import assert from 'node:assert/strict';

const ENGINE = {
  idleRPM: 900,
  stallRPM: 440,
  inertia: 0.19,
  torqueAt: (rpm) => {
    const c = [
      [600, 125], [1000, 165], [1600, 195], [2400, 215], [3400, 228],
    ];
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 0; i < c.length - 1; i++) {
      const [r0, t0] = c[i];
      const [r1, t1] = c[i + 1];
      if (rpm >= r0 && rpm <= r1) {
        const u = (rpm - r0) / (r1 - r0);
        return t0 + (t1 - t0) * u;
      }
    }
    return c[c.length - 1][1];
  },
  dragTorque: (rpm) => 18 + rpm * 0.011,
};

const TRANSMISSION = {
  gearRatios: [4.05, 2.15, 1.42, 1.05, 0.82],
  reverseRatio: 3.9,
  finalDrive: 4.30,
  efficiency: 0.9,
  clutchMaxTorque: 420,
  clutchViscosity: 85,
  clutchLockStiffness: 920,
  clutchLockSlipRad: 4.5,
  hillHoldSpeedMs: 1.15,
  hillHoldTorqueNm: 95,
};

const WHEEL_R = 0.48;

const TIRES = {
  longB: 10.0,
  longC: 1.35,
  longSlipForceCap: 0.22,
  loadSensitivity: 0.000018,
};

/**
 * Low-speed tire Fx — mirrors src/physics/tires.ts crawl blend.
 * Scales so |slip| at the force cap → peak μ (hill starts stay hooked up).
 */
function lowSpeedLongFx(slipRatio, load, grip = 0.72) {
  const D = grip * load;
  const cap = TIRES.longSlipForceCap;
  const slipForFx =
    Math.abs(slipRatio) <= cap ? slipRatio : Math.sign(slipRatio) * cap;
  return Math.max(-D, Math.min(D, (slipForFx / cap) * D));
}

function pacejka(slip, B, C, D) {
  return D * Math.sin(C * Math.atan(B * slip));
}

/** Longitudinal force with force-cap (mirrors src/physics/tires.ts). */
function longFx(slipRatio, load, grip) {
  const muPeak = grip * (1 - TIRES.loadSensitivity * load);
  const D = muPeak * load;
  const cap = TIRES.longSlipForceCap;
  const slipForFx =
    Math.abs(slipRatio) <= cap ? slipRatio : Math.sign(slipRatio) * cap;
  return pacejka(slipForFx, TIRES.longB, TIRES.longC, D);
}

function ratioFor(gear) {
  if (gear === 0) return 0;
  if (gear === -1) return -TRANSMISSION.reverseRatio * TRANSMISSION.finalDrive;
  return TRANSMISSION.gearRatios[gear - 1] * TRANSMISSION.finalDrive;
}

function clutchTorque(slip, engage, rearWheelOmega, throttle, ratio) {
  const engageSq = engage * engage;
  const capacity = TRANSMISSION.clutchMaxTorque * engageSq;
  if (ratio === 0 || capacity <= 0.5) return 0;
  const lockBlend =
    engageSq * (1 - Math.min(1, Math.abs(slip) / TRANSMISSION.clutchLockSlipRad));
  const effectiveVisc =
    TRANSMISSION.clutchViscosity + TRANSMISSION.clutchLockStiffness * lockBlend;
  let Tc = slip * effectiveVisc;
  const speedMs = Math.abs(rearWheelOmega) * WHEEL_R;
  if (engage > 0.92 && speedMs < TRANSMISSION.hillHoldSpeedMs && throttle < 0.08) {
    const creepOpposesGear =
      ratio > 0 ? rearWheelOmega < -0.05 : rearWheelOmega > 0.05;
    if (creepOpposesGear) {
      const hold = TRANSMISSION.hillHoldTorqueNm * engageSq;
      Tc += ratio > 0 ? hold : -hold;
    }
  }
  if (Math.abs(Tc) > capacity) Tc = Math.sign(Tc) * capacity;
  return Tc;
}

/**
 * Integrate engine+clutch for dump-clutch at standstill (wheels locked at 0).
 * Returns final state after `seconds`.
 */
function simulateDumpClutch({ gear, throttle, clutchPedal, seconds, rpm0 = 900 }) {
  const ratio = ratioFor(gear);
  const engage = 1 - clutchPedal;
  const gearboxOmega = 0; // standstill
  let rpm = rpm0;
  let state = 'running';
  const dt = 1 / 120;
  const sub = 8;
  const h = dt / sub;
  let lastDrive = 0;

  for (let step = 0; step < Math.ceil(seconds / dt); step++) {
    let clutchAccum = 0;
    for (let i = 0; i < sub; i++) {
      if (state !== 'running') break;
      const eOmega = (rpm * 2 * Math.PI) / 60;
      const slip = eOmega - gearboxOmega;
      const Tc = clutchTorque(slip, engage, 0, throttle, ratio);
      const clutchLoad = Math.abs(Tc);
      let thr = Math.max(0, Math.min(1, throttle));
      if (thr < 0.05 && clutchLoad < 40) {
        const below = ENGINE.idleRPM - rpm;
        if (below > 0) thr = Math.max(thr, Math.min(0.32, (below / 320) * 0.32));
      }
      const comb = ENGINE.torqueAt(rpm) * thr;
      const drag = ENGINE.dragTorque(rpm);
      const net = comb - drag - Tc;
      rpm += ((net / ENGINE.inertia) * 60) / (2 * Math.PI) * h;
      if (rpm < 0) rpm = 0;
      if (rpm < ENGINE.stallRPM) state = 'stalled';
      clutchAccum += Tc;
    }
    const avgTc = clutchAccum / sub;
    lastDrive = ratio !== 0 ? avgTc * ratio * TRANSMISSION.efficiency : 0;
    if (state === 'stalled') break;
  }
  return { state, rpm, driveTorque: lastDrive };
}

/**
 * Instantaneous wheel drive torque with engine at given RPM and reverse wheel spin
 * (rollback), clutch fully engaged.
 */
function rollbackResistDrive({ gear, rpm, rearWheelOmega, throttle = 0 }) {
  const ratio = ratioFor(gear);
  const engage = 1;
  const eOmega = (rpm * 2 * Math.PI) / 60;
  const gearboxOmega = rearWheelOmega * ratio;
  const slip = eOmega - gearboxOmega;
  const Tc = clutchTorque(slip, engage, rearWheelOmega, throttle, ratio);
  return Tc * ratio * TRANSMISSION.efficiency;
}

// --- checks ---
let failed = 0;
function check(name, cond, detail = '') {
  try {
    assert.ok(cond, detail);
    console.log('OK ', name);
  } catch (e) {
    failed++;
    console.error('FAIL', name, e.message, detail);
  }
}

// 1) Forward drive torque sign in 1st with engine above gearbox
{
  const r = simulateDumpClutch({ gear: 1, throttle: 0.6, clutchPedal: 0, seconds: 0.05 });
  check('1st gear drive torque is forward (+)', r.driveTorque > 0 || r.state === 'stalled',
    `drive=${r.driveTorque.toFixed(1)} state=${r.state}`);
}

// 2) Dump clutch idle in 1st → stall
{
  const r = simulateDumpClutch({ gear: 1, throttle: 0, clutchPedal: 0, seconds: 0.5 });
  check('dump clutch 1st @ idle stalls', r.state === 'stalled', `rpm=${r.rpm} state=${r.state}`);
}

// 3) Dump clutch idle in 3rd → stall
{
  const r = simulateDumpClutch({ gear: 3, throttle: 0, clutchPedal: 0, seconds: 0.5 });
  check('dump clutch 3rd @ idle stalls', r.state === 'stalled', `rpm=${r.rpm} state=${r.state}`);
}

// 4) Gentle slip with throttle stays running long enough to produce +drive
{
  const ratio = ratioFor(1);
  const engage = 0.35;
  const eOmega = (1400 * 2 * Math.PI) / 60;
  const slip = eOmega; // wheels stopped
  const Tc = clutchTorque(slip, engage, 0, 0.5, ratio);
  const drive = Tc * ratio * TRANSMISSION.efficiency;
  check('partial clutch bite produces +wheel torque', drive > 50, `drive=${drive.toFixed(1)}`);
}

// 5) Tire low-speed longitudinal sign (the original crawl inversion bug)
{
  const Fx = lowSpeedLongFx(0.4, 3000);
  check('low-speed tire Fx > 0 for positive slip', Fx > 0, `Fx=${Fx}`);
}

// 5b) Crawl hill-start: capped wheelspin must deliver near-peak μ (not ~10% of D)
{
  const load = 3000;
  const grip = 0.72;
  const D = grip * load;
  const Fx = lowSpeedLongFx(5.0, load, grip); // deep wheelspin, force-capped
  check('low-speed wheelspin Fx near peak grip', Fx > D * 0.9,
    `Fx=${Fx.toFixed(0)} D=${D.toFixed(0)}`);
  const mass = 1720;
  // AWD: all four contact patches at static load share
  const fxAwd = lowSpeedLongFx(5.0, (mass * 9.81) / 4, 0.72) * 4;
  const need12 = mass * 9.81 * 0.12;
  check('AWD crawl Fx climbs ~12% grade', fxAwd > need12,
    `Fx=${fxAwd.toFixed(0)} need=${need12.toFixed(0)}`);
}

// 6) Spawn yaw for -Z-forward chassis aligns with +X road tangent
{
  const tx = 80, tz = 2;
  const yaw = Math.atan2(-tx, -tz);
  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  const dot = fwdX * tx + fwdZ * tz;
  check('spawn yaw faces along road tangent', dot > 0, `dot=${dot} fwd=(${fwdX.toFixed(3)},${fwdZ.toFixed(3)})`);
}

// 7) Engaged clutch resists reverse (rollback) torque — forward (+) wheel drive
{
  // Dead/stalled crank at ~0 RPM, wheels rolling backward slowly
  const drive = rollbackResistDrive({ gear: 1, rpm: 0, rearWheelOmega: -1.2, throttle: 0 });
  check('engaged clutch resists rollback (+drive)', drive > 400,
    `drive=${drive.toFixed(1)}`);
}

// 8) Near-matched idle with tiny reverse creep still produces meaningful hold
{
  // Engine near idle-matched crawl, slight rollback
  const idleOmega = (900 * 2 * Math.PI) / 60;
  const ratio = ratioFor(1);
  // Wheel omega slightly below matched → gearbox lags → positive slip → +drive
  const matchedWheel = idleOmega / ratio;
  const drive = rollbackResistDrive({
    gear: 1,
    rpm: 900,
    rearWheelOmega: matchedWheel - 0.4,
    throttle: 0,
  });
  check('near-lock engine braking opposes lag', drive > 80, `drive=${drive.toFixed(1)}`);
}

// 9) Stall state is terminal (engine does not keep "running")
{
  const r = simulateDumpClutch({ gear: 1, throttle: 0, clutchPedal: 0, seconds: 0.8 });
  check('stall leaves engine stalled/off-like', r.state === 'stalled' && r.rpm < ENGINE.stallRPM,
    `state=${r.state} rpm=${r.rpm}`);
}

// 10) 1st gear full-throttle standstill bite: wheel torque magnitude raised vs old ~4500 peak
{
  const ratio = ratioFor(1);
  const peakEngine = ENGINE.torqueAt(3400);
  const peakWheel = TRANSMISSION.clutchMaxTorque * ratio * TRANSMISSION.efficiency;
  const fullThrottleStandstill = simulateDumpClutch({
    gear: 1, throttle: 1, clutchPedal: 0, seconds: 0.04, rpm0: 4000,
  });
  check('1st gear peak clutch→wheel torque increased', peakWheel > 5500,
    `peakWheel=${peakWheel.toFixed(0)} peakEng=${peakEngine}`);
  check('1st full-throttle standstill drive is large +', fullThrottleStandstill.driveTorque > 2000,
    `drive=${fullThrottleStandstill.driveTorque.toFixed(0)} state=${fullThrottleStandstill.state}`);
}

// 10b) Reverse standstill: clutch must send negative wheel torque (backup)
{
  const rev = simulateDumpClutch({
    gear: -1, throttle: 1, clutchPedal: 0, seconds: 0.04, rpm0: 4000,
  });
  check('reverse full-throttle standstill drive is large -', rev.driveTorque < -2000,
    `drive=${rev.driveTorque.toFixed(0)} state=${rev.state} ratio=${ratioFor(-1).toFixed(2)}`);
}

// 11) Grade climb estimate: full throttle 1st should exceed ~10% grade demand
{
  const mass = 1720;
  const grade = 0.10;
  const needN = mass * 9.81 * grade;
  const needWheelNm = needN * WHEEL_R;
  // Combustion at 3500 rpm full throttle through 1st (engine-limited, clutch can pass)
  const engNm = ENGINE.torqueAt(3500);
  const availWheel = engNm * ratioFor(1) * TRANSMISSION.efficiency;
  check('1st @ 3500rpm can climb ~10% grade', availWheel > needWheelNm * 1.15,
    `avail=${availWheel.toFixed(0)} need=${needWheelNm.toFixed(0)}`);
}

// 12) Tire traction under wheelspin: 1st @ high RPM on dirt must still push uphill
// (previously Pacejka C≈1.85 collapsed Fx to ~27% of peak → "no traction" climb fail)
{
  const mass = 1720;
  const loadWheel = (mass * 9.81) / 4;
  const slipSpin = 5.0; // ≈ 1st locked at ~5k rpm, chassis nearly stopped
  const fxSpin = longFx(slipSpin, loadWheel, 0.72) * 2; // both driven wheels
  const need15 = mass * 9.81 * 0.15;
  check('dirt wheelspin Fx still climbs ~15% grade', fxSpin > need15,
    `Fx2=${fxSpin.toFixed(0)} need15%=${need15.toFixed(0)}`);
  const fxPeak = longFx(0.12, loadWheel, 0.72) * 2;
  check('wheelspin Fx stays near peak (not falling flank)', fxSpin > fxPeak * 0.85,
    `spin=${fxSpin.toFixed(0)} peak=${fxPeak.toFixed(0)}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll powertrain smoke checks passed.');
