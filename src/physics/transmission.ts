import { PHYSICS, SUSPENSION, TRANSMISSION } from '../config';
import { Engine } from './engine';

export type PowertrainEvent =
  | { type: 'stall' }
  | { type: 'shift'; gear: number; ok: boolean }
  | { type: 'grind' }
  | { type: 'start' }
  | { type: 'ignitionDenied' };

export type PowertrainOutput = {
  /** Drive torque at each rear wheel (Nm), RWD split. Front always 0. */
  wheelDriveTorque: [number, number, number, number];
  events: PowertrainEvent[];
  clutchSlip: number;       // |ω_e - ω_t| rad/s when slipping
  clutchLocked: boolean;
  gearboxOmega: number;     // rad/s at input shaft
};

/**
 * Owns Engine + gearbox + capped friction clutch.
 * Shifts require clutch past threshold else grind/reject.
 * Engine braking and stalling emerge from the clutch reaction torque.
 *
 * Locked-clutch model: pure viscous torque → 0 at matched speeds, which felt like
 * free-wheeling on slopes. We blend in lock stiffness at high engagement so
 * small slip still transmits up to capacity (static-friction-like), plus a soft
 * hill-hold assist only when clutch engaged + in gear + very low wheel speed.
 */
export class Powertrain {
  engine = new Engine();
  /** -1 = R, 0 = N, 1..5 */
  gear = 0;
  private events: PowertrainEvent[] = [];

  get gearLabel(): string {
    if (this.gear === -1) return 'R';
    if (this.gear === 0) return 'N';
    return String(this.gear);
  }

  get ratio(): number {
    if (this.gear === 0) return 0;
    if (this.gear === -1) return -TRANSMISSION.reverseRatio * TRANSMISSION.finalDrive;
    return TRANSMISSION.gearRatios[this.gear - 1] * TRANSMISSION.finalDrive;
  }

  drainEvents(): PowertrainEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private push(ev: PowertrainEvent) {
    this.events.push(ev);
  }

  tryIgnition(clutchPedal: number) {
    const ok = this.engine.tryStart(clutchPedal, this.gear === 0);
    if (ok) this.push({ type: 'start' });
    else this.push({ type: 'ignitionDenied' });
  }

  /** Sequential or direct gear change. Clutch must be depressed past threshold. */
  requestGear(target: number, clutchPedal: number) {
    const g = Math.max(-1, Math.min(5, target | 0));
    if (g === this.gear) return;
    if (clutchPedal < TRANSMISSION.shiftClutchThreshold) {
      this.push({ type: 'grind' });
      this.push({ type: 'shift', gear: g, ok: false });
      return;
    }
    this.gear = g;
    this.push({ type: 'shift', gear: g, ok: true });
  }

  shiftUp(clutchPedal: number) {
    if (this.gear >= 5) return;
    // from R -> N -> 1..5
    this.requestGear(this.gear + 1, clutchPedal);
  }

  shiftDown(clutchPedal: number) {
    if (this.gear <= -1) return;
    this.requestGear(this.gear - 1, clutchPedal);
  }

  /**
   * @param rearWheelOmega average rear wheel angular velocity (rad/s), chassis-forward positive
   *        (wheel spinning for forward travel is positive when rolling forward = -Z body).
   */
  update(
    dt: number,
    throttle: number,
    clutchPedal: number,
    rearWheelOmega: number,
  ): PowertrainOutput {
    const prevState = this.engine.state;
    const ratio = this.ratio;
    // Gearbox input shaft speed from wheels (through final drive + gear)
    const gearboxOmega = ratio === 0 ? 0 : rearWheelOmega * ratio;

    // Clutch engagement: pedal 1 = fully disengaged, 0 = fully engaged
    const engage = 1 - Math.max(0, Math.min(1, clutchPedal));
    const engageSq = engage * engage;
    const capacity = TRANSMISSION.clutchMaxTorque * engageSq; // progressive bite

    // Approx longitudinal speed from driven wheels (for soft hill-hold gating)
    const speedMs = Math.abs(rearWheelOmega) * SUSPENSION.wheelRadius;

    const sub = PHYSICS.engineSubsteps;
    const h = dt / sub;
    let clutchTorqueAccum = 0;
    let slipSum = 0;
    let locked = false;

    for (let i = 0; i < sub; i++) {
      const eOmega = (this.engine.rpm * 2 * Math.PI) / 60;
      const slip = eOmega - gearboxOmega;
      slipSum += Math.abs(slip);

      let clutchOnEngine = 0;
      let clutchOnGearbox = 0;

      if (ratio !== 0 && capacity > 0.5) {
        // Kinetic viscosity + engagement-weighted lock stiffness so near-matched
        // speeds still carry driveline torque (engine braking / compression feel).
        const lockBlend =
          engageSq *
          (1 - Math.min(1, Math.abs(slip) / TRANSMISSION.clutchLockSlipRad));
        const effectiveVisc =
          TRANSMISSION.clutchViscosity +
          TRANSMISSION.clutchLockStiffness * lockBlend;
        let Tc = slip * effectiveVisc;

        // Soft hill-hold (NOT perfect park brake): when clutch is fully up, in gear,
        // and creeping very slowly against the gear direction, add clutch-referred
        // resistance so gentle slopes don't free-wheel like neutral. Prefer real
        // engine braking first; this only tops up at crawl speeds.
        if (
          engage > 0.92 &&
          speedMs < TRANSMISSION.hillHoldSpeedMs &&
          throttle < 0.08
        ) {
          // Forward gears: oppose negative (rollback) wheel omega.
          // Reverse gear (ratio < 0): oppose positive wheel omega (rolling "forward").
          const creepOpposesGear =
            ratio > 0 ? rearWheelOmega < -0.05 : rearWheelOmega > 0.05;
          if (creepOpposesGear) {
            // Torque at clutch that yields forward-ish wheel drive (sign via ratio).
            const hold = TRANSMISSION.hillHoldTorqueNm * engageSq;
            // Want drive at wheels opposing rollback → for ratio>0 need +Tc contribution
            // to gearbox path (drive = Tc * ratio * eff). Rollback → add +hold to Tc.
            Tc += ratio > 0 ? hold : -hold;
          }
        }

        if (Math.abs(Tc) > capacity) {
          Tc = Math.sign(Tc) * capacity;
          locked = false;
        } else if (Math.abs(slip) < 2.5 && engage > 0.92) {
          locked = true;
        }
        clutchOnEngine = Tc;
        clutchOnGearbox = Tc;
      } else {
        locked = false;
      }

      this.engine.update(h, throttle, clutchOnEngine);
      clutchTorqueAccum += clutchOnGearbox;
    }

    const avgClutchToGearbox = clutchTorqueAccum / sub;
    const avgSlip = slipSum / sub;

    // Stall event
    if (prevState === 'running' && this.engine.state === 'stalled') {
      this.push({ type: 'stall' });
    }

    let drive = 0;
    if (ratio !== 0) {
      drive = avgClutchToGearbox * ratio * TRANSMISSION.efficiency;
    }
    const half = drive * 0.5;

    return {
      wheelDriveTorque: [0, 0, half, half],
      events: this.drainEvents(),
      clutchSlip: avgSlip,
      clutchLocked: locked && engage > 0.9,
      gearboxOmega,
    };
  }
}
