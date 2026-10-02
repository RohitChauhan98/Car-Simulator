/** SVG tach/speedo, gear, input bars, warning lights, surface, toasts, pause. */

import { ENGINE, BRAKES, SURFACES, INPUT_RATES } from '../config';

const TACH_MAX = 8000;
const SPEED_MAX_KMH = 200;
/** Needle sweep: -120° (left) … +120° (right), 0° = up. */
const SWEEP_MIN = -120;
const SWEEP_SPAN = 240;

export type HudState = {
  rpm: number;
  speedMs: number;
  /** Display gear: R | N | 1–5 */
  gearLabel: string;
  throttle: number;
  brake: number;
  clutch: number;
  steer?: number;
  stalled?: boolean;
  handbrake: boolean;
  /** Explicit check-engine; defaults from stalled / engineState */
  checkEngine?: boolean;
  /** Brake fade warning; inferred from brakeTemp if omitted */
  fade?: boolean;
  brakeTemp?: number;
  fuelCut?: boolean;
  engineState?: string;
  /** Surface id (0–5) or name string */
  surface?: number | string;
};

function needlePath(angleDeg: number, cx: number, cy: number, r: number): string {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const x = cx + Math.cos(a) * r;
  const y = cy + Math.sin(a) * r;
  return `M ${cx} ${cy} L ${x} ${y}`;
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

/** Arc path from angleA to angleB (degrees, needle convention). */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
}

function valueToAngle(value: number, max: number): number {
  const t = Math.max(0, Math.min(1, value / max));
  return SWEEP_MIN + t * SWEEP_SPAN;
}

function tickMarks(
  max: number,
  step: number,
  majorEvery: number,
  labelDivisor: number,
): string {
  const parts: string[] = [];
  for (let v = 0; v <= max; v += step) {
    const ang = valueToAngle(v, max);
    const major = v % majorEvery === 0;
    const outer = 44;
    const inner = major ? 36 : 40;
    const a = polar(50, 50, outer, ang);
    const b = polar(50, 50, inner, ang);
    parts.push(
      `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="rgba(255,255,255,${major ? 0.55 : 0.25})" stroke-width="${major ? 1.4 : 0.9}"/>`,
    );
    if (major && labelDivisor > 0) {
      const lab = polar(50, 50, 30, ang);
      const text = String(v / labelDivisor);
      parts.push(
        `<text x="${lab.x.toFixed(2)}" y="${lab.y.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" fill="rgba(232,236,240,0.55)" font-size="6" font-family="sans-serif">${text}</text>`,
      );
    }
  }
  return parts.join('');
}

function surfaceName(surface: number | string | undefined): string {
  if (surface === undefined) return '—';
  if (typeof surface === 'string') return surface;
  return (SURFACES[surface] ?? SURFACES[0]).name;
}

export class Hud {
  private root: HTMLElement;
  private tachNeedle: SVGPathElement;
  private speedNeedle: SVGPathElement;
  private tachValue: HTMLElement;
  private speedValue: HTMLElement;
  private gearEl: HTMLElement;
  private surfaceEl: HTMLElement;
  private bars: HTMLElement;
  private throttleFill: HTMLElement;
  private brakeFill: HTMLElement;
  private clutchFill: HTMLElement;
  private steerFill: HTMLElement;
  private checkWarn: HTMLElement;
  private hbWarn: HTMLElement;
  private fadeWarn: HTMLElement;
  private limWarn: HTMLElement;
  private toasts: HTMLElement;
  private pauseOverlay: HTMLElement;
  private helpBtn: HTMLButtonElement;
  private helpOverlay: HTMLElement;
  private barsVisible = false;
  private helpVisible = false;
  private onHelpKeyDown: (e: KeyboardEvent) => void;

  /** Left-edge clutch hold button: 0 = engaged, 1 = fully pressed. */
  private clutchSlider = 0;
  private clutchPointerId: number | null = null;
  private clutchHeld = false;
  private clutchSpringing = false;
  private clutchSpringFrom = 0;
  private clutchSpringT = 0;
  private readonly clutchSpringDuration = 0.32;
  private clutchBtn: HTMLButtonElement;
  private clutchFillEl: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = container;

    const redStart = valueToAngle(ENGINE.redlineRPM, TACH_MAX);
    const redEnd = valueToAngle(TACH_MAX, TACH_MAX);
    const redArc = arcPath(50, 50, 42, redStart, redEnd);

    this.root.innerHTML = `
      <button type="button" class="help-btn" id="help-btn" aria-label="Controls help" title="Controls (I)">i</button>
      <button type="button" class="clutch-btn" id="clutch-btn" tabindex="-1" title="Clutch — hold to press, springs back on release">
        <div class="clutch-btn-fill" id="clutch-fill"></div>
        <span class="clutch-btn-label">Clutch</span>
      </button>
      <div class="warnings">
        <div class="warn check-engine" id="warn-check">Check</div>
        <div class="warn handbrake" id="warn-hb">Hold</div>
        <div class="warn fade" id="warn-fade">Fade</div>
        <div class="warn limiter" id="warn-lim">Limiter</div>
      </div>
      <div class="surface-readout" id="surface-readout">—</div>
      <div class="toasts" id="toasts"></div>
      <div class="hud-cluster">
        <div class="gauge" id="tach">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="46" fill="rgba(8,10,14,0.55)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
            <path d="${redArc}" fill="none" stroke="#e04030" stroke-width="5" stroke-linecap="butt" opacity="0.9"/>
            ${tickMarks(TACH_MAX, 500, 1000, 1000)}
            <path d="M 50 50 L 50 12" id="tach-needle" stroke="#e8ecf0" stroke-width="2.4" stroke-linecap="round"/>
            <circle cx="50" cy="50" r="3.5" fill="#e8ecf0"/>
          </svg>
          <div class="gauge-value" id="tach-val">0.0</div>
          <div class="gauge-label">RPM ×1000</div>
        </div>
        <div class="gear-badge" id="gear">N</div>
        <div class="gauge" id="speedo">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="46" fill="rgba(8,10,14,0.55)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
            ${tickMarks(SPEED_MAX_KMH, 10, 40, 1)}
            <path d="M 50 50 L 50 12" id="speed-needle" stroke="#7ec8e3" stroke-width="2.4" stroke-linecap="round"/>
            <circle cx="50" cy="50" r="3.5" fill="#7ec8e3"/>
          </svg>
          <div class="gauge-value" id="speed-val">0</div>
          <div class="gauge-label">km/h</div>
        </div>
      </div>
      <div class="input-bars" id="input-bars">
        <div class="bar-row"><span>Thr</span><div class="bar-track"><div class="bar-fill" id="bar-thr"></div></div></div>
        <div class="bar-row"><span>Brk</span><div class="bar-track"><div class="bar-fill brake" id="bar-brk"></div></div></div>
        <div class="bar-row"><span>Clu</span><div class="bar-track"><div class="bar-fill clutch" id="bar-clu"></div></div></div>
        <div class="bar-row"><span>Str</span><div class="bar-track"><div class="bar-fill steer" id="bar-str"></div></div></div>
      </div>
      <div class="pause-overlay" id="pause-overlay">
        <div class="pause-card">
          <h2>Paused</h2>
          <p>Press P to resume</p>
          <div class="controls-help">
            <div><b>W/S</b> throttle/brake &nbsp; <b>A/D</b> steer</div>
            <div><b>Clutch button</b> (left, hold) or <b>Shift</b> — springs back when released</div>
            <div><b>Q/E</b> shift (Q from N = reverse) &nbsp; <b>R</b> reverse &nbsp; <b>1–5</b> gears &nbsp; <b>N</b> neutral</div>
            <div><b>R</b> also starts when the engine is off (hold clutch or N) &nbsp; <b>Space</b> handbrake &nbsp; <b>C</b> camera &nbsp; <b>H</b> bars</div>
          </div>
        </div>
      </div>
      <div class="help-overlay" id="help-overlay" aria-hidden="true">
        <div class="help-card" role="dialog" aria-labelledby="help-title">
          <button type="button" class="help-close" id="help-close" aria-label="Close help">&times;</button>
          <h2 id="help-title">Controls</h2>
          <div class="controls-help">
            <div><b>W / S</b> throttle / brake &nbsp; <b>A / D</b> steer</div>
            <div><b>Clutch button</b> (left edge) — hold to press; springs back on release</div>
            <div><b>Left Shift</b> clutch (hold, accessibility)</div>
            <div><b>Q / E</b> shift down / up (Q from N selects reverse)</div>
            <div><b>1–5</b> direct gear &nbsp; <b>R</b> reverse (when running) &nbsp; <b>\` or 0</b> reverse &nbsp; <b>N</b> neutral</div>
            <div><b>R</b> also starts the engine when it is off (clutch pressed or N)</div>
            <div><b>Space</b> handbrake</div>
            <div><b>C</b> camera &nbsp; <b>H</b> input bars &nbsp; <b>P</b> pause</div>
            <div><b>Mouse</b> orbit camera (click to lock) &nbsp; <b>scroll</b> zoom &nbsp; <b>RMB</b> look</div>
            <div>Add <b>?audioDebug</b> to the URL for live vehicle audio meters</div>
          </div>
          <h3>Driving tips</h3>
          <ul class="help-tips">
            <li>Hold the left clutch button (or Shift); release gently for a smooth bite.</li>
            <li>Hold clutch, press <b>R</b> for reverse, then W to go backward (S is still brake).</li>
            <li>Release the clutch gently in 1st to pull away without stalling.</li>
            <li>In gear with clutch up, the driveline resists rollback (engine braking).</li>
            <li>Wrong gear or dumping the clutch can stall the engine — restart with clutch + R (starter motor).</li>
          </ul>
          <p class="help-hint">Press <b>I</b> or <b>Esc</b> to close</p>
        </div>
      </div>
    `;

    this.tachNeedle = this.root.querySelector('#tach-needle')!;
    this.speedNeedle = this.root.querySelector('#speed-needle')!;
    this.tachValue = this.root.querySelector('#tach-val')!;
    this.speedValue = this.root.querySelector('#speed-val')!;
    this.gearEl = this.root.querySelector('#gear')!;
    this.surfaceEl = this.root.querySelector('#surface-readout')!;
    this.bars = this.root.querySelector('#input-bars')!;
    this.throttleFill = this.root.querySelector('#bar-thr')!;
    this.brakeFill = this.root.querySelector('#bar-brk')!;
    this.clutchFill = this.root.querySelector('#bar-clu')!;
    this.steerFill = this.root.querySelector('#bar-str')!;
    this.checkWarn = this.root.querySelector('#warn-check')!;
    this.hbWarn = this.root.querySelector('#warn-hb')!;
    this.fadeWarn = this.root.querySelector('#warn-fade')!;
    this.limWarn = this.root.querySelector('#warn-lim')!;
    this.toasts = this.root.querySelector('#toasts')!;
    this.pauseOverlay = this.root.querySelector('#pause-overlay')!;
    this.helpBtn = this.root.querySelector('#help-btn')!;
    this.helpOverlay = this.root.querySelector('#help-overlay')!;
    this.clutchFillEl = this.root.querySelector('#clutch-fill')!;
    const helpClose = this.root.querySelector('#help-close')!;
    const helpCard = this.helpOverlay.querySelector('.help-card')!;
    this.clutchBtn = this.root.querySelector('#clutch-btn') as HTMLButtonElement;
    const clutchBtn = this.clutchBtn;

    this.helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp();
    });
    helpClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setHelpVisible(false);
    });
    this.helpOverlay.addEventListener('click', () => this.setHelpVisible(false));
    helpCard.addEventListener('click', (e) => e.stopPropagation());

    this.onHelpKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyI' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.toggleHelp();
        return;
      }
      if (e.code === 'Escape' && this.helpVisible) {
        e.preventDefault();
        this.setHelpVisible(false);
      }
    };
    window.addEventListener('keydown', this.onHelpKeyDown);

    const onClutchPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.clutchSpringing = false;
      this.clutchPointerId = e.pointerId;
      this.clutchHeld = true;
      clutchBtn.setPointerCapture(e.pointerId);
      clutchBtn.classList.add('active');
    };
    const onClutchPointerUp = (e: PointerEvent) => {
      if (this.clutchPointerId !== e.pointerId) return;
      this.clutchPointerId = null;
      this.clutchHeld = false;
      clutchBtn.classList.remove('active');
      try {
        clutchBtn.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      this.startClutchSpring();
    };
    clutchBtn.addEventListener('pointerdown', onClutchPointerDown);
    clutchBtn.addEventListener('pointerup', onClutchPointerUp);
    clutchBtn.addEventListener('pointercancel', onClutchPointerUp);
    // Swallow the synthetic click so a held button never toggles focus/keys.
    clutchBtn.addEventListener('click', (e) => e.preventDefault());
    clutchBtn.addEventListener('lostpointercapture', () => {
      if (this.clutchPointerId !== null) {
        this.clutchPointerId = null;
        this.clutchHeld = false;
        clutchBtn.classList.remove('active');
        this.startClutchSpring();
      }
    });

    this.syncClutchSliderVisual();
  }

  /**
   * Current clutch pedal from the left hold button (0 = engaged, 1 = pressed).
   * While held this overrides keyboard; otherwise the spring-return value is
   * merged with keyboard via Math.max in main.
   */
  getClutchSlider(): number {
    return this.clutchSlider;
  }

  /** True while the user is holding the clutch button. */
  isClutchSliderActive(): boolean {
    return this.clutchPointerId !== null;
  }

  /** Advance press ramp / spring-return animation; call each frame with dt seconds. */
  tickClutchSpring(dt: number): void {
    if (this.clutchHeld) {
      if (this.clutchSlider < 1) {
        this.clutchSlider = Math.min(1, this.clutchSlider + INPUT_RATES.clutchAttack * dt);
        this.syncClutchSliderVisual();
      }
      return;
    }
    if (!this.clutchSpringing) return;
    this.clutchSpringT += dt;
    const u = Math.min(1, this.clutchSpringT / this.clutchSpringDuration);
    // Smooth ease-out (spring-ish)
    const eased = 1 - (1 - u) * (1 - u) * (1 - u);
    this.clutchSlider = this.clutchSpringFrom * (1 - eased);
    if (u >= 1) {
      this.clutchSlider = 0;
      this.clutchSpringing = false;
    }
    this.syncClutchSliderVisual();
  }

  private startClutchSpring(): void {
    if (this.clutchSlider <= 0.001) {
      this.clutchSlider = 0;
      this.clutchSpringing = false;
      this.syncClutchSliderVisual();
      return;
    }
    this.clutchSpringing = true;
    this.clutchSpringFrom = this.clutchSlider;
    this.clutchSpringT = 0;
  }

  private syncClutchSliderVisual(): void {
    this.clutchFillEl.style.height = `${this.clutchSlider * 100}%`;
  }

  toggleBars(): void {
    this.barsVisible = !this.barsVisible;
    this.bars.classList.toggle('visible', this.barsVisible);
  }

  setBarsVisible(visible: boolean): void {
    this.barsVisible = visible;
    this.bars.classList.toggle('visible', visible);
  }

  toggleHelp(): void {
    this.setHelpVisible(!this.helpVisible);
  }

  setHelpVisible(visible: boolean): void {
    this.helpVisible = visible;
    this.helpOverlay.classList.toggle('visible', visible);
    this.helpOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    this.helpBtn.classList.toggle('active', visible);
    this.helpBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }

  setPaused(paused: boolean): void {
    this.pauseOverlay.classList.toggle('visible', paused);
  }

  toast(msg: string, ms = 1800): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    this.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  update(state: HudState): void {
    const rpm = Math.max(0, state.rpm);
    const tachAng = valueToAngle(Math.min(TACH_MAX, rpm), TACH_MAX);
    this.tachNeedle.setAttribute('d', needlePath(tachAng, 50, 50, 36));
    this.tachNeedle.setAttribute('stroke', rpm >= ENGINE.redlineRPM ? '#ff6a4a' : '#e8ecf0');
    this.tachValue.textContent = (rpm / 1000).toFixed(1);

    const kmh = Math.max(0, state.speedMs) * 3.6;
    const spdAng = valueToAngle(Math.min(SPEED_MAX_KMH, kmh), SPEED_MAX_KMH);
    this.speedNeedle.setAttribute('d', needlePath(spdAng, 50, 50, 36));
    this.speedValue.textContent = String(Math.round(kmh));

    this.gearEl.textContent = state.gearLabel || 'N';

    this.throttleFill.style.width = `${clamp01(state.throttle) * 100}%`;
    this.brakeFill.style.width = `${clamp01(state.brake) * 100}%`;
    this.clutchFill.style.width = `${clamp01(state.clutch) * 100}%`;
    this.steerFill.style.width = `${Math.abs(state.steer ?? 0) * 100}%`;

    const engineOffish =
      state.engineState === 'stalled' ||
      state.engineState === 'off' ||
      !!state.stalled;
    const check =
      state.checkEngine !== undefined ? state.checkEngine : engineOffish;
    this.checkWarn.classList.toggle('on', check);
    this.hbWarn.classList.toggle('on', !!state.handbrake);

    const fade =
      state.fade !== undefined
        ? state.fade
        : state.brakeTemp !== undefined && state.brakeTemp >= BRAKES.fadeStartTemp;
    this.fadeWarn.classList.toggle('on', fade);
    this.limWarn.classList.toggle('on', !!state.fuelCut);

    this.surfaceEl.textContent = surfaceName(state.surface);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
