import { BRAKES } from '../config';

export type BrakeOutput = {
  /** Brake torque magnitude per wheel [FL, FR, RL, RR], Nm */
  torques: [number, number, number, number];
  temperature: number;
  fade: number;
};

/**
 * Pedal brakes with front/rear bias, handbrake on rears, and thermal fade.
 */
export class Brakes {
  temperature = BRAKES.ambientTemp;

  update(
    dt: number,
    pedal: number,
    handbrake: boolean,
    wheelSpeedsAbs: number[], // |ω| rad/s per wheel
    speedMs: number,
  ): BrakeOutput {
    const p = Math.max(0, Math.min(1, pedal));
    const fade = this.fadeFactor();
    const front = BRAKES.maxTorque * p * fade;
    const rear = BRAKES.maxTorque * BRAKES.rearBias * p * fade;
    const hb = handbrake ? BRAKES.handbrakeTorque : 0;

    const torques: [number, number, number, number] = [
      front,
      front,
      rear + hb,
      rear + hb,
    ];

    // Heat from brake work ≈ torque * |ω|
    let work = 0;
    for (let i = 0; i < 4; i++) work += torques[i] * wheelSpeedsAbs[i];
    this.temperature += work * BRAKES.heatRate * dt;
    // Cool with airflow
    const cool = BRAKES.coolRate * (1 + Math.abs(speedMs) * 0.08);
    this.temperature += (BRAKES.ambientTemp - this.temperature) * cool * dt;
    if (this.temperature < BRAKES.ambientTemp) this.temperature = BRAKES.ambientTemp;

    return { torques, temperature: this.temperature, fade };
  }

  private fadeFactor(): number {
    if (this.temperature <= BRAKES.fadeStartTemp) return 1;
    if (this.temperature >= BRAKES.fadeEndTemp) return 1 - BRAKES.maxFade;
    const u = (this.temperature - BRAKES.fadeStartTemp) /
      (BRAKES.fadeEndTemp - BRAKES.fadeStartTemp);
    return 1 - u * BRAKES.maxFade;
  }
}
