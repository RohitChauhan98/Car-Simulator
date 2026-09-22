import { AUDIO, ENGINE } from '../config';
import { VEHICLE_AUDIO } from './config';
import type { AudioGraph } from './graph';
import type { SampleBank } from './samples';
import { LoopVoice, playOneShot } from './voices';
import {
  ENGINE_LAYERS,
  LAYER_BASE_RPM,
  engineAggression,
  engineLayerWeights,
  layerPlaybackRate,
  clamp01,
} from './mapping';
import type { EngineLayerId, EngineLoadMode } from './types';

function setParam(p: AudioParam | undefined, value: number, now: number, tau: number): void {
  if (!p) return;
  const v = Number.isFinite(value) ? value : 0;
  // Worklet AudioParams often ignore setTargetAtTime unless .value is set.
  p.value = v;
  try {
    p.setTargetAtTime(v, now, Math.max(0.008, tau));
  } catch {
    /* value assignment is enough */
  }
}

type LayerVoice = {
  id: EngineLayerId;
  set: (gain: number, rpm: number, now: number) => void;
  levels: () => number;
};

class BufferEngineLayer implements LayerVoice {
  readonly id: EngineLayerId;
  private voice: LoopVoice;
  private gain = 0;

  constructor(id: EngineLayerId, graph: AudioGraph, bank: SampleBank) {
    this.id = id;
    this.voice = new LoopVoice(graph.ctx, graph.engineBus);
    this.voice.setBuffer(bank.get(`engine.${id}`));
  }

  set(gain: number, rpm: number, now: number): void {
    const tau = gain > this.gain ? 0.03 : 0.08;
    this.gain = gain;
    this.voice.setGain(gain, now, tau);
    this.voice.setRate(layerPlaybackRate(rpm, LAYER_BASE_RPM[this.id]), now, 0.04);
  }

  levels(): number {
    return this.gain;
  }
}

/**
 * Combustion-pulse engine: AudioWorklet firing-rate synth, with recorded
 * loops only if the user dropped real WAVs. Starter / stall / catch are
 * first-class states, not a pitched musical drone.
 */
export class EngineAudio {
  private node: AudioWorkletNode | null = null;
  private layers: LayerVoice[] = [];
  private useWorklet = false;
  private boom: BiquadFilterNode;
  private body: BiquadFilterNode;
  private lpf: BiquadFilterNode;
  private bayBleed: GainNode;
  private exhaustGain: GainNode;
  private mechGain: GainNode;
  private duckUntil = 0;
  private stallUntil = 0;
  private backfireUntil = 0;
  private catchUntil = 0;
  private stallRpm = 0;
  private liveRpm = 0;
  private prevState = 'off';
  private solenoidBuf: AudioBuffer;
  private disengageBuf: AudioBuffer;
  starterGain = 0;
  combustGain = 0;
  get usingWorklet(): boolean {
    return this.useWorklet;
  }
  layerGains: Record<EngineLayerId, number> = {
    idle: 0, low: 0, mid: 0, high: 0, redline: 0,
  };

  constructor(private graph: AudioGraph, private bank: SampleBank) {
    const ctx = graph.ctx;

    this.boom = ctx.createBiquadFilter();
    this.boom.type = 'lowshelf';
    this.boom.frequency.value = 110;
    this.boom.gain.value = 4.5;

    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 165;
    this.body.Q.value = 0.65;
    this.body.gain.value = 2.8;

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 1400;
    this.lpf.Q.value = 0.55;

    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0;
    this.bayBleed = ctx.createGain();
    this.bayBleed.gain.value = 0.18;
    this.mechGain = ctx.createGain();
    this.mechGain.gain.value = 0;

    this.boom.connect(this.body);
    this.body.connect(this.lpf);
    this.lpf.connect(this.exhaustGain);
    this.exhaustGain.connect(graph.exhaustPanner.input);
    this.lpf.connect(this.bayBleed);
    this.bayBleed.connect(graph.enginePanner.input);
    this.mechGain.connect(graph.enginePanner.input);

    this.solenoidBuf = makeSolenoid(ctx, 'engage');
    this.disengageBuf = makeSolenoid(ctx, 'disengage');
  }

  async init(): Promise<void> {
    const ctx = this.graph.ctx;
    if (this.bank.engineUsesFiles()) {
      this.layers = ENGINE_LAYERS.map((id) => new BufferEngineLayer(id, this.graph, this.bank));
      return;
    }
    try {
      await ctx.audioWorklet.addModule('/audio/worklets/combustion-processor.js?v=4');
      this.node = new AudioWorkletNode(ctx, 'combustion-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.node.onprocessorerror = (ev) => {
        console.warn('[audio] combustion worklet error, using pulse loops', ev);
        this.useWorklet = false;
        this.node?.disconnect();
        this.node = null;
        if (!this.layers.length) {
          this.layers = ENGINE_LAYERS.map((id) => new BufferEngineLayer(id, this.graph, this.bank));
        }
      };
      this.node.connect(this.boom);
      const cyl = this.node.parameters.get('cylinders');
      if (cyl) cyl.value = AUDIO.cylinders;
      this.useWorklet = true;
    } catch (err) {
      console.warn('[audio] combustion worklet unavailable, using pulse loops', err);
      this.layers = ENGINE_LAYERS.map((id) => new BufferEngineLayer(id, this.graph, this.bank));
    }
  }

  duckShift(now: number): void {
    this.duckUntil = now + 0.11;
  }

  playSolenoidEngage(): void {
    playOneShot(this.graph.ctx, this.solenoidBuf, this.graph.enginePanner.input, {
      gain: 0.55 * AUDIO.sfx,
      duration: 0.12,
    });
  }

  playSolenoidDisengage(): void {
    playOneShot(this.graph.ctx, this.disengageBuf, this.graph.enginePanner.input, {
      gain: 0.32 * AUDIO.sfx,
      duration: 0.07,
    });
  }

  playIgnitionDenied(): void {
    playOneShot(this.graph.ctx, this.solenoidBuf, this.graph.enginePanner.input, {
      gain: 0.2 * AUDIO.sfx,
      rate: 1.15,
      duration: 0.04,
    });
  }

  beginStall(now: number): void {
    this.stallUntil = now + 0.72;
    this.backfireUntil = now + 0.12;
    this.catchUntil = 0;
    this.stallRpm = Math.max(this.liveRpm, ENGINE.stallRPM);
  }

  notifyState(state: string, now: number): void {
    if (state === 'cranking' && this.prevState !== 'cranking') {
      this.catchUntil = 0;
    }
    if (state === 'running' && this.prevState === 'cranking') {
      this.catchUntil = now + 0.42;
      this.playSolenoidDisengage();
    }
    if (
      (state === 'stalled' || state === 'off') &&
      (this.prevState === 'running' || this.prevState === 'cranking') &&
      now >= this.stallUntil
    ) {
      this.beginStall(now);
    }
    this.prevState = state;
  }

  update(opts: {
    rpm: number;
    throttle: number;
    load: number;
    loadMode: EngineLoadMode;
    state: string;
    fuelCut: boolean;
    interior: number;
    coldStart?: number;
    now: number;
  }): void {
    const { rpm, throttle, load, loadMode, state, fuelCut, interior, now } = opts;
    const cold = opts.coldStart ?? 0;
    const dead = state === 'stalled' || state === 'off';
    const collapsing = now < this.stallUntil;
    const catching = now < this.catchUntil;
    const cranking = state === 'cranking';
    const agr = engineAggression(loadMode, throttle, load);
    const duck = now < this.duckUntil ? 0.72 : 1;
    const interiorScale = 1 - interior * (1 - VEHICLE_AUDIO.interior.engineInteriorScale);

    if (!dead) this.liveRpm = rpm;

    let combust = 0;
    let starter = 0;
    let irregular = 0.05 + cold * 0.14;
    let synthRpm = rpm;

    if (cranking) {
      starter = 0.92;
      combust = 0.08 + clamp01(rpm / Math.max(1, ENGINE.crankRPM)) * 0.1;
      irregular = 0.58;
      synthRpm = Math.max(rpm, 90);
    } else if (state === 'running') {
      combust = (0.38 + agr * 0.7) * duck * interiorScale;
      if (loadMode === 'coast') combust *= 0.72;
      if (loadMode === 'engineBrake') {
        combust *= 0.62;
        irregular += 0.12;
      }
      irregular += rpm < ENGINE.idleRPM + 160 ? 0.1 : 0;
      if (catching) {
        const u = 1 - (this.catchUntil - now) / 0.42;
        starter = (1 - u) * 0.78;
        combust *= 0.28 + u * 0.72;
        irregular = 0.48 * (1 - u) + irregular * u;
      }
    } else if (collapsing) {
      const t = 1 - (this.stallUntil - now) / 0.72;
      synthRpm = this.stallRpm * Math.max(0.08, 1 - t);
      combust = 0.42 * (1 - t) * (0.25 + Math.random() * 0.8);
      irregular = 0.92;
      starter = 0;
    }

    if (fuelCut && state === 'running') {
      combust *= 0.1 + (Math.sin(now * 85) > 0 ? 0.85 : 0);
      irregular = Math.max(irregular, 0.4);
    }

    this.combustGain = combust;
    this.starterGain = starter;
    const weights = engineLayerWeights(synthRpm);
    for (const id of ENGINE_LAYERS) {
      this.layerGains[id] = weights[id] * combust;
    }

    if (this.useWorklet && this.node) {
      const p = this.node.parameters;
      setParam(p.get('rpm'), synthRpm, now, cranking || collapsing || catching ? 0.016 : 0.028);
      setParam(p.get('load'), clamp01(load * 0.5 + throttle * 0.55), now, 0.045);
      setParam(p.get('combust'), combust, now, cranking ? 0.025 : 0.05);
      setParam(p.get('starter'), starter, now, 0.018);
      setParam(p.get('irregular'), irregular, now, 0.04);
      setParam(p.get('fuelCut'), fuelCut && state === 'running' ? 1 : 0, now, 0.01);
      setParam(p.get('backfire'), now < this.backfireUntil ? 1 : 0, now, 0.008);
      const intakeAmt =
        state === 'running' ? throttle * (0.18 + agr * 0.55) * (1 - interior * 0.3) : 0;
      setParam(p.get('intake'), intakeAmt, now, throttle > 0.2 ? 0.02 : 0.07);

      const cutoff = 620 + synthRpm * 0.42 + agr * 2400;
      this.lpf.frequency.setTargetAtTime(
        interior > 0.5 ? Math.min(1500, cutoff * 0.5) : Math.min(5200, cutoff),
        now,
        0.07,
      );
      this.boom.gain.setTargetAtTime(3.8 + (1 - agr) * 2.2, now, 0.1);
      this.body.gain.setTargetAtTime(2.2 + agr * 1.4, now, 0.08);

      const alive = !(dead && !collapsing);
      const exGain = (alive ? 1 : 0) * (interior > 0.5 ? 0.5 : 1);
      this.exhaustGain.gain.value = exGain;
      this.exhaustGain.gain.setTargetAtTime(exGain, now, 0.05);
      this.mechGain.gain.value = 0;
      this.bayBleed.gain.value = alive ? (interior > 0.5 ? 0.28 : 0.16) : 0;
    } else {
      const amp = combust;
      for (const layer of this.layers) {
        let g = weights[layer.id] * amp;
        if (loadMode === 'coast' && (layer.id === 'high' || layer.id === 'redline')) g *= 0.45;
        layer.set(g, synthRpm, now);
      }
    }
  }
}

function makeSolenoid(ctx: AudioContext, kind: 'engage' | 'disengage'): AudioBuffer {
  const dur = kind === 'engage' ? 0.11 : 0.06;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let lp = 0;
  const thudHz = kind === 'engage' ? 72 : 140;
  const clickHz = kind === 'engage' ? 1650 : 2100;
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    const white = Math.random() * 2 - 1;
    lp += 0.18 * (white - lp);
    const thud = Math.sin(2 * Math.PI * thudHz * t) * Math.exp(-t * 42);
    const click = Math.sin(2 * Math.PI * clickHz * t) * Math.exp(-t * 90);
    const grit = lp * Math.exp(-t * 38);
    const env = t < 0.003 ? t / 0.003 : Math.exp(-(t - 0.003) * 28);
    d[i] = (thud * 0.7 + grit * 0.55 + click * 0.28) * env * (kind === 'engage' ? 0.95 : 0.7);
  }
  return buf;
}
