import { AUDIO, SURFACES } from '../config';
import type { WheelVisual } from '../physics/vehicle';

/**
 * Procedural one-shots + continuous loops (Web Audio only, no samples).
 * Shared noise buffer feeds squeal / gravel / wind / river / bursts.
 * Gains respect AUDIO.sfx / AUDIO.ambience / AUDIO.master.
 *
 * Call start() after a user gesture (or pass an existing AudioContext).
 */
export class GameSFX {
  private ctx: AudioContext | null = null;
  private ready = false;
  private noiseBuf: AudioBuffer | null = null;

  private master: GainNode | null = null;
  private ambMaster: GainNode | null = null;

  private squeal: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
  private gravel: GainNode | null = null;
  private gravelFilter: BiquadFilterNode | null = null;
  private clutchNode: GainNode | null = null;
  private clutchOsc: OscillatorNode | null = null;
  private clutchHiss: GainNode | null = null;
  private wind: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private river: GainNode | null = null;
  private riverFilter: BiquadFilterNode | null = null;

  private lastThudAt = 0;

  constructor(ctx?: AudioContext) {
    if (ctx) {
      this.ctx = ctx;
      this.buildGraph();
    }
  }

  /** Create / resume AudioContext after a user gesture. */
  async start(shared?: AudioContext): Promise<AudioContext> {
    if (shared) this.ctx = shared;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.ready) this.buildGraph();
    return this.ctx;
  }

  async resume(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx || this.ready) return;

    this.noiseBuf = makeNoiseBuffer(ctx, 2);

    this.master = ctx.createGain();
    this.master.gain.value = AUDIO.sfx * AUDIO.master;
    this.master.connect(ctx.destination);

    this.ambMaster = ctx.createGain();
    this.ambMaster.gain.value = AUDIO.ambience * AUDIO.master;
    this.ambMaster.connect(ctx.destination);

    // Tire squeal — resonant filtered noise
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1200;
    this.squealFilter.Q.value = 9;
    this.squeal = ctx.createGain();
    this.squeal.gain.value = 0;
    this.loopNoise().connect(this.squealFilter);
    this.squealFilter.connect(this.squeal);
    this.squeal.connect(this.master);

    // Gravel / loose-surface crunch
    this.gravelFilter = ctx.createBiquadFilter();
    this.gravelFilter.type = 'bandpass';
    this.gravelFilter.frequency.value = 620;
    this.gravelFilter.Q.value = 1.4;
    this.gravel = ctx.createGain();
    this.gravel.gain.value = 0;
    const gravelSrc = this.loopNoise(1.15);
    gravelSrc.connect(this.gravelFilter);
    this.gravelFilter.connect(this.gravel);
    this.gravel.connect(this.master);

    // Clutch slip: sawtooth whine + hiss
    this.clutchNode = ctx.createGain();
    this.clutchNode.gain.value = 0;
    this.clutchOsc = ctx.createOscillator();
    this.clutchOsc.type = 'sawtooth';
    this.clutchOsc.frequency.value = 180;
    const cF = ctx.createBiquadFilter();
    cF.type = 'lowpass';
    cF.frequency.value = 950;
    this.clutchOsc.connect(cF);
    cF.connect(this.clutchNode);
    this.clutchNode.connect(this.master);
    this.clutchOsc.start();

    this.clutchHiss = ctx.createGain();
    this.clutchHiss.gain.value = 0;
    const hissF = ctx.createBiquadFilter();
    hissF.type = 'highpass';
    hissF.frequency.value = 1800;
    this.loopNoise().connect(hissF);
    hissF.connect(this.clutchHiss);
    this.clutchHiss.connect(this.master);

    // Wind ambience
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 380;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.04;
    this.loopNoise(0.85).connect(this.windFilter);
    this.windFilter.connect(this.wind);
    this.wind.connect(this.ambMaster);

    // River by distance
    this.riverFilter = ctx.createBiquadFilter();
    this.riverFilter.type = 'lowpass';
    this.riverFilter.frequency.value = 520;
    this.riverFilter.Q.value = 0.6;
    this.river = ctx.createGain();
    this.river.gain.value = 0.1;
    this.loopNoise(0.7).connect(this.riverFilter);
    this.riverFilter.connect(this.river);
    this.river.connect(this.ambMaster);

    this.ready = true;
  }

  private loopNoise(playbackRate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf!;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start();
    return src;
  }

  /** Filtered noise burst one-shot. */
  private burst(
    duration: number,
    freq: number,
    type: BiquadFilterType,
    gain = 0.4,
    q = 1,
  ): void {
    if (!this.ready || !this.ctx || !this.master || !this.noiseBuf) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;

    // Envelope via gain; truncate by stop time
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.001, gain), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  playShift(): void {
    this.burst(0.09, 180, 'lowpass', 0.55, 0.8);
    // Metallic click layer
    this.burst(0.04, 1400, 'bandpass', 0.22, 4);
  }

  playGrind(): void {
    this.burst(0.22, 780, 'bandpass', 0.48, 2.2);
    this.burst(0.18, 320, 'highpass', 0.2, 1);
  }

  playStall(): void {
    if (!this.ready || !this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(130, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.65);

    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, now);
    f.frequency.exponentialRampToValueAtTime(120, now + 0.65);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.38 * AUDIO.sfx, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.75);

    osc.connect(f);
    f.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.8);

    this.burst(0.15, 90, 'lowpass', 0.3, 0.7);
  }

  /** Suspension bottom-out / impact thud. */
  playThud(): void {
    this.burst(0.07, 110, 'lowpass', 0.32, 0.9);
    this.burst(0.05, 55, 'lowpass', 0.2, 0.5);
  }

  /** Alias for callers that still use playSuspension. */
  playSuspension(): void {
    this.playThud();
  }

  /** Starter one-shot (main may also rely on engine cranking layer). */
  playStarter(): void {
    if (!this.ready || !this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 92;

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 13;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 38;
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);

    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 260;
    f.Q.value = 2.2;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22 * AUDIO.sfx, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.95);

    osc.connect(f);
    f.connect(g);
    g.connect(this.master);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 1);
    lfo.stop(now + 1);
  }

  update(
    wheels: WheelVisual[],
    speedMs: number,
    clutchSlip: number,
    clutchPedal: number,
    distToRiver: number,
  ): void {
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;

    // Keep bus gains in sync with config
    if (this.master) this.master.gain.setTargetAtTime(AUDIO.sfx * AUDIO.master, now, 0.2);
    if (this.ambMaster) {
      this.ambMaster.gain.setTargetAtTime(AUDIO.ambience * AUDIO.master, now, 0.2);
    }

    let maxSlip = 0;
    let gravelAmt = 0;
    let suspBump = false;

    for (const w of wheels) {
      maxSlip = Math.max(maxSlip, w.slipLat, w.slip * 0.55);
      const surf = SURFACES[w.surfaceId] ?? SURFACES[0];
      if (surf.roughness > 0.3 && w.grounded) {
        const wheelSpeed = Math.abs(w.omega) * 0.34; // ~radius, m/s
        const fromOmega = Math.min(1, wheelSpeed * 0.08);
        gravelAmt = Math.max(gravelAmt, fromOmega * surf.roughness);
      }
      if (w.compression > 0.82 && w.grounded) suspBump = true;
    }

    // Tire squeal above slip threshold
    if (this.squeal && this.squealFilter) {
      const squealAmt = Math.max(0, maxSlip - 0.22) * 1.6;
      this.squeal.gain.setTargetAtTime(Math.min(0.5, squealAmt), now, 0.045);
      this.squealFilter.frequency.setTargetAtTime(850 + maxSlip * 900, now, 0.05);
      this.squealFilter.Q.setTargetAtTime(6 + maxSlip * 6, now, 0.08);
    }

    // Gravel crunch from wheel speed on loose surfaces
    if (this.gravel && this.gravelFilter) {
      this.gravel.gain.setTargetAtTime(gravelAmt * 0.35, now, 0.07);
      this.gravelFilter.frequency.setTargetAtTime(420 + gravelAmt * 380, now, 0.08);
    }

    // Clutch slip hiss + whine (engaged-ish pedal, significant speed delta)
    const slipping = clutchPedal < 0.92 && clutchSlip > 6;
    const slipAmt = slipping ? Math.min(0.28, clutchSlip * 0.009) : 0;
    if (this.clutchNode) this.clutchNode.gain.setTargetAtTime(slipAmt, now, 0.04);
    if (this.clutchHiss) this.clutchHiss.gain.setTargetAtTime(slipAmt * 0.55, now, 0.04);
    if (this.clutchOsc && slipping) {
      this.clutchOsc.frequency.setTargetAtTime(140 + clutchSlip * 2.5, now, 0.05);
    }

    // Wind from speed
    if (this.wind && this.windFilter) {
      const w = 0.025 + Math.min(0.4, Math.abs(speedMs) * 0.009);
      this.wind.gain.setTargetAtTime(w, now, 0.12);
      this.windFilter.frequency.setTargetAtTime(280 + Math.abs(speedMs) * 12, now, 0.15);
    }

    // River falloff by distance
    if (this.river) {
      const riverVol = Math.max(0, 1 - Math.abs(distToRiver) / 130) * 0.22;
      this.river.gain.setTargetAtTime(riverVol, now, 0.25);
    }

    // Auto thud on hard suspension hits (rate-limited)
    if (suspBump && now - this.lastThudAt > 0.18 && Math.random() < 0.12) {
      this.lastThudAt = now;
      this.playThud();
    }
  }
}

/** Back-compat alias used by main.ts */
export { GameSFX as Sfx };

function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
