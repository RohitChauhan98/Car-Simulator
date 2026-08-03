import { ENGINE } from '../config';

export type EngineState = 'off' | 'cranking' | 'running' | 'stalled';

function lerpTorque(rpm: number): number {
  const c = ENGINE.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  if (rpm >= c[c.length - 1][0]) return c[c.length - 1][1];
  for (let i = 0; i < c.length - 1; i++) {
    const [r0, t0] = c[i];
    const [r1, t1] = c[i + 1];
    if (rpm >= r0 && rpm <= r1) {
      const u = (rpm - r0) / (r1 - r0);
      return t0 + (t1 - t0) * u;
    }
  }
  return c[c.length - 1][1];
}

/**
 * Scalar engine ODE: RPM from net torque, with idle control, stall, limiter,
 * starter crank, and cold-start idle wobble.
 */
export class Engine {
  state: EngineState = 'off';
  rpm = 0;
  /** True while soft rev-limiter is cutting fuel. */
  fuelCut = false;
  /** 0..1 load estimate for audio (combustion demand). */
  load = 0;
  /** Effective throttle after idle controller (0..1). */
  effectiveThrottle = 0;

  private crankTimer = 0;
  private coldTimer = 0;
  private hasStartedOnce = false;
  private wobblePhase = 0;

  get running() {
    return this.state === 'running' || this.state === 'cranking';
  }

  /** Instantaneous combustion torque at given rpm & throttle (Nm). */
  combustionTorque(rpm: number, throttle: number): number {
    if (this.fuelCut || this.state === 'off' || this.state === 'stalled') return 0;
    if (this.state === 'cranking') return 35; // starter assist
    return lerpTorque(rpm) * Math.max(0, Math.min(1, throttle));
  }

  /**
   * Attempt restart. Requires clutch pedal pressed OR gearbox in neutral.
   * Returns true if cranking began.
   */
  tryStart(clutchPedal: number, inNeutral: boolean): boolean {
    if (this.state === 'running' || this.state === 'cranking') return false;
    if (clutchPedal < 0.5 && !inNeutral) return false;
    this.state = 'cranking';
    this.crankTimer = ENGINE.crankTime;
    this.fuelCut = false;
    if (this.rpm < ENGINE.crankRPM) this.rpm = ENGINE.crankRPM * 0.4;
    return true;
  }

  kill() {
    this.state = 'off';
    this.rpm = 0;
    this.fuelCut = false;
    this.load = 0;
    this.effectiveThrottle = 0;
  }

  /**
   * Integrate one sub-step.
   * @param clutchReactionTorque torque the clutch applies *to the engine* (Nm).
   *        Positive reaction slows the engine when driving the wheels.
   */
  update(dt: number, driverThrottle: number, clutchReactionTorque: number) {
    if (this.state === 'off' || this.state === 'stalled') {
      // Dead crank: collapse RPM quickly and ignore combustion. Clutch still
      // couples against this near-zero shaft in transmission (anti-rollback).
      this.rpm = Math.max(0, this.rpm - 2800 * dt);
      this.load = 0;
      this.effectiveThrottle = 0;
      this.fuelCut = false;
      return;
    }

    if (this.state === 'cranking') {
      this.crankTimer -= dt;
      // starter spins toward crankRPM
      const err = ENGINE.crankRPM - this.rpm;
      this.rpm += err * 4 * dt;
      if (this.crankTimer <= 0) {
        this.state = 'running';
        this.rpm = Math.max(this.rpm, ENGINE.idleRPM * 0.85);
        if (!this.hasStartedOnce) {
          this.coldTimer = ENGINE.coldStartDuration;
          this.hasStartedOnce = true;
        }
      }
      this.effectiveThrottle = 0.15;
      this.load = 0.2;
      return;
    }

    // ---- running ----
    // Soft rev limiter: cut above redline, resume below limiterResumeRPM
    if (this.rpm >= ENGINE.redlineRPM) this.fuelCut = true;
    if (this.fuelCut && this.rpm < ENGINE.limiterResumeRPM) this.fuelCut = false;

    // Idle controller: add throttle when below idle — but not when the clutch is
    // dragging the crank hard (dump / wrong gear). Otherwise idle fuel fights stall.
    let throttle = Math.max(0, Math.min(1, driverThrottle));
    const clutchLoad = Math.abs(clutchReactionTorque);
    if (throttle < 0.05 && clutchLoad < 40) {
      const below = ENGINE.idleRPM - this.rpm;
      if (below > 0) {
        const idleAdd = Math.min(
          ENGINE.idleThrottleMax,
          (below / ENGINE.idleControlBand) * ENGINE.idleThrottleMax,
        );
        throttle = Math.max(throttle, idleAdd);
      }
    }

    // Cold-start idle wobble
    if (this.coldTimer > 0) {
      this.coldTimer -= dt;
      this.wobblePhase += dt * 11;
      const wobble = Math.sin(this.wobblePhase) * 0.08 * (this.coldTimer / ENGINE.coldStartDuration);
      throttle = Math.max(0, Math.min(1, throttle + wobble));
    }

    this.effectiveThrottle = throttle;

    const comb = this.combustionTorque(this.rpm, throttle);
    const drag = ENGINE.dragTorque(this.rpm);
    // Net torque on crankshaft. clutchReactionTorque is opposing when engine drives wheels.
    const net = comb - drag - clutchReactionTorque;
    // τ = I α ; ω_rpm = ω_rad * 60 / (2π)
    const alphaRad = net / ENGINE.inertia;
    this.rpm += (alphaRad * 60) / (2 * Math.PI) * dt;

    if (this.rpm > ENGINE.maxRPM) this.rpm = ENGINE.maxRPM;
    if (this.rpm < 0) this.rpm = 0;

    // Stall: below stallRPM while clutch is loading the engine enough to drag it down
    if (this.rpm < ENGINE.stallRPM) {
      this.state = 'stalled';
      this.fuelCut = false;
      this.load = 0;
      return;
    }

    // Load for audio: combustion demand relative to available torque
    const avail = Math.max(1, lerpTorque(this.rpm));
    this.load = Math.max(0, Math.min(1, (comb + Math.abs(clutchReactionTorque) * 0.3) / avail));
  }
}
