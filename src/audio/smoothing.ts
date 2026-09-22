/**
 * Exponential smoother with separate attack/release rates (1/seconds).
 * Never map raw physics values straight to audio parameters.
 */
export class SmoothParam {
  value: number;

  constructor(
    initial = 0,
    readonly attack = 10,
    readonly release = 6,
  ) {
    this.value = initial;
  }

  tick(target: number, dt: number): number {
    const rate = target > this.value ? this.attack : this.release;
    const k = 1 - Math.exp(-rate * Math.max(0, dt));
    this.value += (target - this.value) * k;
    return this.value;
  }

  reset(v = 0): void {
    this.value = v;
  }
}
