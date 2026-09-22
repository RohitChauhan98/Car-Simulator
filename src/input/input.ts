import { INPUT_RATES, STEERING } from '../config';

/** Discrete one-shot actions emitted by the input layer. */
export type InputAction =
  | 'shiftUp' | 'shiftDown' | 'neutral' | 'reverse'
  | 'gear1' | 'gear2' | 'gear3' | 'gear4' | 'gear5'
  | 'ignition' | 'camera' | 'toggleBars' | 'pause';

/**
 * Keyboard + gamepad abstraction. Digital keys are ramped into analog pedal
 * values so keyboard driving still has progressive clutch/throttle behavior.
 */
export class Input {
  throttle = 0;
  brake = 0;
  clutch = 0;     // 0 = released (engaged clutch), 1 = pedal to the floor (disengaged)
  steer = 0;      // -1 (right) .. +1 (left)
  handbrake = false;

  /** Accumulated mouse look since last consumeLook(). */
  lookDx = 0;
  lookDy = 0;
  zoomDelta = 0;
  pointerLocked = false;
  lookEnabled = false;
  private rightDrag = false;

  private keys = new Set<string>();
  private actions: InputAction[] = [];
  private gamepadIndex: number | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.onKeyDown(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Digit0', 'Backquote'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => (this.gamepadIndex = e.gamepad.index));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadIndex = null));
  }

  /** Pointer-lock look on the game canvas. HUD widgets keep their own pointer events. */
  bindLook(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      if (!this.lookEnabled) return;
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock().catch(() => {});
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.lookEnabled) return;
      if (this.pointerLocked || this.rightDrag) {
        this.lookDx += e.movementX;
        this.lookDy += e.movementY;
      }
    });
    canvas.addEventListener('contextmenu', (e) => {
      if (this.lookEnabled) e.preventDefault();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.lookEnabled) return;
      if (e.button === 2) this.rightDrag = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightDrag = false;
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.lookEnabled) return;
      e.preventDefault();
      this.zoomDelta += e.deltaY;
    }, { passive: false });
  }

  setLookEnabled(enabled: boolean) {
    this.lookEnabled = enabled;
    if (!enabled && this.canvas && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  consumeLook(): { dx: number; dy: number; zoom: number } {
    const out = { dx: this.lookDx, dy: this.lookDy, zoom: this.zoomDelta };
    this.lookDx = 0;
    this.lookDy = 0;
    this.zoomDelta = 0;
    return out;
  }

  private onKeyDown(code: string) {
    const map: Record<string, InputAction> = {
      KeyE: 'shiftUp', KeyQ: 'shiftDown', KeyN: 'neutral',
      Backquote: 'reverse', Digit0: 'reverse',
      Digit1: 'gear1', Digit2: 'gear2', Digit3: 'gear3', Digit4: 'gear4', Digit5: 'gear5',
      KeyR: 'ignition', KeyC: 'camera', KeyH: 'toggleBars', KeyP: 'pause',
    };
    const a = map[code];
    if (a) this.actions.push(a);
  }

  /** Drain the pending one-shot actions. */
  consumeActions(): InputAction[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  private key(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  private static ramp(value: number, target: number, up: number, down: number, dt: number) {
    if (target > value) return Math.min(target, value + up * dt);
    return Math.max(target, value - down * dt);
  }

  update(dt: number) {
    const R = INPUT_RATES;

    // ---- gamepad ----
    let gpThrottle = 0, gpBrake = 0, gpSteer = 0, gpClutch = 0, gpHand = false;
    if (this.gamepadIndex !== null) {
      const gp = navigator.getGamepads()[this.gamepadIndex];
      if (gp) {
        const dz = (v: number) => (Math.abs(v) < R.deadzone ? 0 : v);
        gpSteer = -dz(gp.axes[0] ?? 0);
        gpThrottle = gp.buttons[7]?.value ?? 0;
        gpBrake = gp.buttons[6]?.value ?? 0;
        gpClutch = gp.buttons[4]?.pressed ? 1 : 0;
        gpHand = gp.buttons[5]?.pressed ?? false;
        if (gp.buttons[0]?.pressed && !this.prevGpButtons[0]) this.actions.push('shiftUp');
        if (gp.buttons[2]?.pressed && !this.prevGpButtons[2]) this.actions.push('shiftDown');
        if (gp.buttons[1]?.pressed && !this.prevGpButtons[1]) this.actions.push('ignition');
        if (gp.buttons[3]?.pressed && !this.prevGpButtons[3]) this.actions.push('camera');
        this.prevGpButtons = gp.buttons.map((b) => b.pressed);
      }
    }

    // ---- keyboard targets ----
    const tThrottle = this.key('KeyW', 'ArrowUp') ? 1 : 0;
    const tBrake = this.key('KeyS', 'ArrowDown') ? 1 : 0;
    const tClutch = this.key('ShiftLeft', 'ShiftRight') ? 1 : 0;
    let tSteer = 0;
    if (this.key('KeyA', 'ArrowLeft')) tSteer += 1;
    if (this.key('KeyD', 'ArrowRight')) tSteer -= 1;

    this.throttle = Input.ramp(this.throttle, tThrottle, R.throttleAttack, R.throttleRelease, dt);
    this.brake = Input.ramp(this.brake, tBrake, R.brakeAttack, R.brakeRelease, dt);
    this.clutch = Input.ramp(this.clutch, tClutch, R.clutchAttack, R.clutchRelease, dt);
    if (tSteer !== 0) {
      this.steer = Input.ramp(this.steer, tSteer, STEERING.steerSpeed, STEERING.steerSpeed, dt);
    } else {
      this.steer = Input.ramp(this.steer, 0, STEERING.returnSpeed, STEERING.returnSpeed, dt);
    }

    // merge with gamepad (whichever is stronger wins)
    this.throttle = Math.max(this.throttle, gpThrottle);
    this.brake = Math.max(this.brake, gpBrake);
    this.clutch = Math.max(this.clutch, gpClutch);
    if (Math.abs(gpSteer) > Math.abs(this.steer)) this.steer = gpSteer;
    this.handbrake = this.key('Space') || gpHand;
  }

  private prevGpButtons: boolean[] = [];
}
