import { PHYSICS } from '../config';

export type LoopCallbacks = {
  /** Fixed physics step at PHYSICS.dt. */
  fixedUpdate: (dt: number) => void;
  /** Render with interpolation alpha in [0,1]. */
  render: (alpha: number, frameDt: number) => void;
};

/**
 * Decoupled render loop: accumulate wall time and run fixed 120 Hz physics
 * steps (capped), then render with residual alpha for interpolation.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private raf = 0;
  private running = false;
  paused = false;

  constructor(private cb: LoopCallbacks) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      let frameDt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      // clamp huge hitch so we don't spiral
      if (frameDt > 0.1) frameDt = 0.1;

      if (!this.paused) {
        this.accumulator += frameDt;
        let steps = 0;
        while (this.accumulator >= PHYSICS.dt && steps < PHYSICS.maxStepsPerFrame) {
          this.cb.fixedUpdate(PHYSICS.dt);
          this.accumulator -= PHYSICS.dt;
          steps++;
        }
        if (steps === PHYSICS.maxStepsPerFrame) {
          this.accumulator = 0;
        }
      }

      const alpha = this.paused ? 1 : this.accumulator / PHYSICS.dt;
      this.cb.render(alpha, frameDt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) {
      this.lastTime = performance.now();
      this.accumulator = 0;
    }
    return this.paused;
  }
}
