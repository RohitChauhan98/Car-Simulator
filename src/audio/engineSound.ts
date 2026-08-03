import { AUDIO, ENGINE } from '../config';

export type EngineAudioState = {
  rpm: number;
  load: number;
  state: string;
  fuelCut: boolean;
};

/**
 * Procedural engine synth (Web Audio only):
 * detuned oscillators + noise → waveshaper → LPF.
 * Fundamental from RPM firing frequency; load crossfade; limiter stutter;
 * starter whine while cranking; stall pitch collapse.
 *
 * Call start() after a user gesture (or pass an existing AudioContext).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private ready = false;

  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private highLoadGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;

  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private dets = [0, -7, 12];

  /** Dedicated starter-motor layer (LFO-modulated square). */
  private starterGain: GainNode | null = null;
  private starterOsc: OscillatorNode | null = null;
  private starterLfo: OscillatorNode | null = null;

  private prevState = 'off';
  private stallCollapseUntil = 0;
  private stutterPhase = 0;

  constructor(ctx?: AudioContext) {
    if (ctx) {
      this.ctx = ctx;
      this.buildGraph();
    }
  }

  /** Create / resume AudioContext after a user gesture. Returns the context. */
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

  /** Per-frame engine audio state. */
  setState(s: EngineAudioState): void {
    this.apply(s.rpm, s.load, s.state, s.fuelCut);
  }

  /** Positional update matching existing call sites. */
  update(rpm: number, load: number, state: string, fuelCut: boolean): void {
    this.apply(rpm, load, state, fuelCut);
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx || this.ready) return;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.85;
    this.filter.connect(this.master);

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeDistortionCurve(0.45);
    this.shaper.oversample = '2x';
    this.shaper.connect(this.filter);

    this.highLoadGain = ctx.createGain();
    this.highLoadGain.gain.value = 0;
    this.highLoadGain.connect(this.shaper);

    // 3 detuned saw/pulse oscillators → mild/high-load paths
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? 'square' : 'sawtooth';
      osc.frequency.value = 40;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.24 : i === 1 ? 0.12 : 0.1;
      osc.connect(g);
      g.connect(i === 2 ? this.highLoadGain : this.shaper);
      this.oscs.push(osc);
      this.oscGains.push(g);
      osc.start();
    }

    // Combustion roughness via looped noise through bandpass
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = makeNoiseBuffer(ctx, 1.5);
    noiseSrc.loop = true;

    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = 0.55;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.03;
    noiseSrc.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.shaper);
    noiseSrc.start();

    // Starter motor: square + LFO FM, gated by cranking state
    this.starterGain = ctx.createGain();
    this.starterGain.gain.value = 0;
    this.starterGain.connect(this.master);

    this.starterOsc = ctx.createOscillator();
    this.starterOsc.type = 'square';
    this.starterOsc.frequency.value = 95;

    const starterTone = ctx.createBiquadFilter();
    starterTone.type = 'bandpass';
    starterTone.frequency.value = 280;
    starterTone.Q.value = 2.5;

    this.starterLfo = ctx.createOscillator();
    this.starterLfo.type = 'sine';
    this.starterLfo.frequency.value = 14;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 35;
    this.starterLfo.connect(lfoDepth);
    lfoDepth.connect(this.starterOsc.frequency);

    this.starterOsc.connect(starterTone);
    starterTone.connect(this.starterGain);
    this.starterOsc.start();
    this.starterLfo.start();

    this.ready = true;
  }

  private apply(rpm: number, load: number, state: string, fuelCut: boolean): void {
    if (!this.ready || !this.ctx || !this.master || !this.filter) return;
    const now = this.ctx.currentTime;
    const t = 0.025;
    const dead = state === 'stalled' || state === 'off';

    // Stall / kill transition → brief pitch collapse, then hard silence
    if (dead && (this.prevState === 'running' || this.prevState === 'cranking')) {
      this.stallCollapseUntil = now + 0.35;
    }
    this.prevState = state;

    const collapsing = now < this.stallCollapseUntil;
    const collapseT = collapsing
      ? 1 - (this.stallCollapseUntil - now) / 0.35
      : 0;

    // 4-stroke firing frequency (Hz) from RPM
    const firing = (Math.max(0, rpm) / 60) * (AUDIO.cylinders / 2);
    let baseFreq = Math.max(18, firing);
    if (collapsing) {
      baseFreq = Math.max(8, baseFreq * (1 - collapseT * 0.95));
    }

    for (let i = 0; i < this.oscs.length; i++) {
      const det = this.dets[i] ?? 0;
      const f = baseFreq * Math.pow(2, det / 12);
      this.oscs[i].frequency.setTargetAtTime(f, now, t);
      // Mute per-oscillator gains when fully dead so nothing roars under master
      if (this.oscGains[i]) {
        const base = i === 0 ? 0.24 : i === 1 ? 0.12 : 0.1;
        const g = dead && !collapsing ? 0 : collapsing ? base * (1 - collapseT) : base;
        this.oscGains[i].gain.setTargetAtTime(g, now, dead ? 0.02 : 0.05);
      }
    }

    if (this.noiseFilter) {
      this.noiseFilter.frequency.setTargetAtTime(
        280 + load * 520 + rpm * 0.04,
        now,
        0.05,
      );
    }

    // Amplitude from engine state — stalled/off → 0 after short cut-out
    let amp = 0;
    const engineGain = AUDIO.engine * AUDIO.master;

    if (state === 'running') {
      amp = engineGain * (0.22 + clamp01(load) * 0.78);
    } else if (state === 'cranking') {
      // Quiet combustion bed under the starter whine
      amp = engineGain * 0.18;
    } else if (collapsing) {
      amp = engineGain * (0.28 * (1 - collapseT));
    } else {
      amp = 0;
    }

    // Soft rev-limiter stutter (gate master gain)
    if (fuelCut && state === 'running') {
      this.stutterPhase += 1;
      const gate = Math.sin(now * 85 + this.stutterPhase * 0.3) > 0.15 ? 1 : 0.04;
      amp *= gate;
    }

    // Idle wobble hint near idle RPM
    if (state === 'running' && rpm < ENGINE.idleRPM + 200) {
      amp *= 0.92 + 0.08 * Math.sin(now * 9.5);
    }

    // Immediate cut on stall/off once collapse finishes (avoid lingering roar)
    if (dead && !collapsing) {
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(0, now);
    } else {
      this.master.gain.setTargetAtTime(amp, now, collapsing ? 0.045 : 0.035);
    }

    // Filter opens with load + RPM
    const cutoff = 520 + clamp01(load) * 3000 + rpm * 0.18;
    this.filter.frequency.setTargetAtTime(
      collapsing ? cutoff * (1 - collapseT * 0.7) : cutoff,
      now,
      0.05,
    );

    // High-load harmonic crossfade (square detune layer)
    if (this.highLoadGain) {
      const hi = state === 'running' ? clamp01(load) * 0.4 : 0;
      this.highLoadGain.gain.setTargetAtTime(hi, now, 0.07);
    }

    if (this.noiseGain) {
      const n =
        state === 'running' || state === 'cranking'
          ? 0.018 + clamp01(load) * 0.07
          : collapsing
            ? 0.035 * (1 - collapseT)
            : 0;
      this.noiseGain.gain.setTargetAtTime(n, now, dead ? 0.02 : 0.05);
    }

    // Starter whine — always off when stalled/off
    if (this.starterGain && this.starterOsc) {
      const cranking = state === 'cranking';
      this.starterGain.gain.setTargetAtTime(
        cranking ? engineGain * 0.28 : 0,
        now,
        0.02,
      );
      if (cranking) {
        const whine = 80 + (rpm / Math.max(1, ENGINE.crankRPM)) * 40;
        this.starterOsc.frequency.setTargetAtTime(whine, now, 0.05);
      }
    }
  }
}

/** Back-compat alias used by main.ts */
export { AudioEngine as EngineSound };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function makeDistortionCurve(amount: number): Float32Array {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
