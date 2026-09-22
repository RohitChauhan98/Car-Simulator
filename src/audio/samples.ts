import { AUDIO } from '../config';
import type { EngineLayerId, SurfaceType } from './types';
import { ENGINE_LAYERS, SURFACE_TYPES } from './mapping';
import { VEHICLE_AUDIO } from './config';

export type SampleKind =
  | 'engine'
  | 'tire'
  | 'skid'
  | 'brake'
  | 'trans'
  | 'susp'
  | 'impact'
  | 'scrape'
  | 'noise';

function seamlessLoop(data: Float32Array, fade = 256): void {
  const n = data.length;
  const f = Math.min(fade, (n / 2) | 0);
  for (let i = 0; i < f; i++) {
    const w = i / f;
    const a = data[n - f + i];
    const b = data[i];
    const mixed = a * (1 - w) + b * w;
    data[n - f + i] = mixed;
    data[i] = mixed;
  }
}

function fillHarmonic(
  data: Float32Array,
  sampleRate: number,
  f0: number,
  harmonics: number,
  brightness: number,
  noise: number,
  seed: number,
): void {
  const n = data.length;
  const cycles = Math.max(1, Math.round(f0 * (n / sampleRate)));
  const f = cycles / (n / sampleRate);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      const a = 1 / Math.pow(h, brightness);
      v += a * Math.sin(2 * Math.PI * f * h * t);
    }
    v += (rnd() * 2 - 1) * noise;
    data[i] = v * 0.22;
  }
  seamlessLoop(data);
}

function fillGrainyNoise(
  data: Float32Array,
  seed: number,
  hp: number,
  lp: number,
  grain = 0,
): void {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  let lpState = 0;
  let hpState = 0;
  let brown = 0;
  for (let i = 0; i < data.length; i++) {
    const white = rnd() * 2 - 1;
    brown += 0.02 * (white - brown);
    lpState += lp * (white - lpState);
    hpState += hp * (lpState - hpState);
    let v = (lpState - hpState) * 0.45 + brown * 0.25;
    if (grain > 0 && rnd() < grain * 0.012) v += (rnd() * 2 - 1) * grain * 0.8;
    data[i] = v;
  }
  seamlessLoop(data, 512);
}

function fillCombustionLoop(
  data: Float32Array,
  sampleRate: number,
  rpm: number,
  load: number,
  seed: number,
): void {
  const n = data.length;
  const fireHz = Math.max(8, (rpm / 60) * (AUDIO.cylinders / 2));
  const seconds = n / sampleRate;
  const cycles = Math.max(1, Math.round(fireHz * seconds));
  const actualHz = cycles / seconds;
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  let env = 0;
  let gas = 0;
  let lp = 0;
  let lpSlow = 0;
  let brown = 0;
  const pipe = new Float32Array(256);
  let pi = 0;
  const pipeDelay = Math.min(255, Math.max(8, Math.round(sampleRate * 0.0046)));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = (t * actualHz) % 1;
    const prev = ((i - 1) / sampleRate) * actualHz % 1;
    if (i === 0 || phase < prev) {
      const punch = 0.5 + load * 0.55 + rnd() * 0.08;
      env = punch;
      gas = punch * 0.7;
    }
    env *= Math.exp(-1 / (0.0052 * sampleRate));
    gas *= Math.exp(-1 / (0.013 * sampleRate));
    const white = rnd() * 2 - 1;
    brown += 0.018 * (white - brown);
    const burst = (brown * 0.65 + white * 0.35) * env;
    lp += 0.2 * (burst - lp);
    lpSlow += 0.045 * (gas * (0.35 + brown * 0.4) - lpSlow);
    let pulse = lp * 1.85 + lpSlow * 2.35;
    const delayed = pipe[(pi - pipeDelay + pipe.length) % pipe.length];
    pulse = pulse + delayed * (0.26 + load * 0.18);
    pipe[pi] = (lp * 1.85) * 0.9;
    pi = (pi + 1) % pipe.length;
    data[i] = pulse * 0.35;
  }
  seamlessLoop(data, 256);
}

function fillStarterLoop(data: Float32Array, sampleRate: number): void {
  let brown = 0;
  let lp = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const white = Math.random() * 2 - 1;
    brown += 0.014 * (white - brown);
    lp += 0.09 * (brown - lp);
    const hp = brown - lp;
    const motorHz = 110;
    const ph = (t * motorHz) % 1;
    const pwm = ph < 0.62 ? 1 : 0.22;
    const lope = 0.72 + 0.28 * Math.sin(2 * Math.PI * 8 * t);
    const tooth = ((t * 190) % 1) < 0.03 ? white * 0.45 : 0;
    data[i] = (hp * 1.4 * pwm + lp * 0.85 + tooth) * lope;
  }
  seamlessLoop(data, 256);
}

function fillResonantNoise(
  data: Float32Array,
  sampleRate: number,
  freq: number,
  q: number,
  seed: number,
): void {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const f = (2 * Math.PI * freq) / sampleRate;
  const fb = q;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = rnd() * 2 - 1;
    const y = x - y2 * fb + y1 * (2 * Math.cos(f) * (1 - fb * 0.05));
    y2 = y1;
    y1 = y * 0.92;
    data[i] = y * 0.15;
  }
  seamlessLoop(data, 256);
}

function makeBuffer(
  ctx: AudioContext,
  seconds: number,
  fill: (data: Float32Array, sampleRate: number) => void,
): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  fill(buf.getChannelData(0), ctx.sampleRate);
  return buf;
}

function impactBurst(
  ctx: AudioContext,
  seconds: number,
  seed: number,
  rumble: number,
  click: number,
): AudioBuffer {
  return makeBuffer(ctx, seconds, (data, sr) => {
    let s = seed;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    let lp = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * (8 + click * 8));
      const white = rnd() * 2 - 1;
      lp += 0.12 * (white - lp);
      const thump = lp * (0.9 + rumble) * Math.exp(-t * 10);
      data[i] = (lp * 0.55 + white * 0.22 * click + thump * 0.4) * env;
    }
  });
}

function placeholderFor(ctx: AudioContext, key: string): AudioBuffer {
  if (key.startsWith('engine.')) {
    const layer = key.slice('engine.'.length);
    if (layer === 'starter') {
      return makeBuffer(ctx, 1.2, (data, sr) => fillStarterLoop(data, sr));
    }
    if (layer === 'intake') {
      return makeBuffer(ctx, 1.6, (data) => fillGrainyNoise(data, hash(key), 0.12, 0.28, 0));
    }
    const rpmLoad: Record<string, [number, number]> = {
      idle: [900, 0.15],
      low: [2200, 0.35],
      mid: [3750, 0.55],
      high: [5250, 0.75],
      redline: [6500, 0.95],
      exhaust: [2800, 0.6],
    };
    const [rpm, load] = rpmLoad[layer] ?? [2000, 0.4];
    return makeBuffer(ctx, 2.0, (data, sr) => fillCombustionLoop(data, sr, rpm, load, hash(key)));
  }
  if (key.startsWith('tire.roll.')) {
    const surface = key.slice('tire.roll.'.length);
    const grit: Record<string, [number, number, number]> = {
      tarmac: [0.02, 0.32, 0.05],
      dirt: [0.07, 0.2, 0.35],
      gravel: [0.12, 0.26, 0.7],
      scree: [0.16, 0.3, 0.85],
      grass: [0.05, 0.16, 0.2],
      rock: [0.1, 0.28, 0.45],
      mud: [0.03, 0.1, 0.12],
      water: [0.04, 0.18, 0.08],
    };
    const [hp, lp, grain] = grit[surface] ?? [0.08, 0.22, 0.3];
    return makeBuffer(ctx, 1.8, (data) => fillGrainyNoise(data, hash(key), hp, lp, grain));
  }
  if (key === 'tire.skid.squeal') {
    return makeBuffer(ctx, 1.5, (data, sr) => fillResonantNoise(data, sr, 720, 0.62, 11));
  }
  if (key === 'tire.skid.grit') {
    return makeBuffer(ctx, 1.6, (data) => fillGrainyNoise(data, 17, 0.08, 0.2, 0.7));
  }
  if (key === 'brake.mechanical') {
    return makeBuffer(ctx, 1.4, (data, sr) => {
      let s = 23;
      const rnd = () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
      };
      let lp = 0;
      let hp = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / sr;
        const white = rnd() * 2 - 1;
        lp += 0.06 * (white - lp);
        hp += 0.25 * (white - hp);
        const grit = (white - hp) * 0.35;
        const tick = ((t * 38) % 1) < 0.04 ? white * 0.22 : 0;
        data[i] = lp * 0.7 + grit * 0.4 + tick;
      }
      seamlessLoop(data, 256);
    });
  }
  if (key.startsWith('scrape.')) {
    return makeBuffer(ctx, 1.5, (data) => fillGrainyNoise(data, hash(key), 0.09, 0.22, 0.4));
  }
  if (key.startsWith('susp.')) {
    const size = key.slice('susp.'.length);
    const dur = size === 'large' ? 0.32 : size === 'medium' ? 0.2 : 0.11;
    const rumble = size === 'large' ? 1 : size === 'medium' ? 0.55 : 0.25;
    return impactBurst(ctx, dur, hash(key), rumble, 0.25);
  }
  if (key.startsWith('impact.')) {
    const parts = key.split('.');
    const mat = parts[1] ?? 'dirt';
    const rumble =
      mat === 'metal' || mat === 'vehicle' ? 0.65
      : mat === 'wood' ? 0.4
      : mat === 'rock' ? 0.85
      : mat === 'glass' ? 0.15
      : mat === 'water' ? 0.25
      : 0.45;
    const click = mat === 'glass' || mat === 'metal' ? 0.85 : 0.35;
    return impactBurst(ctx, 0.26, hash(key), rumble, click);
  }
  if (key.startsWith('trans.')) {
    return impactBurst(ctx, key.endsWith('grind') ? 0.2 : 0.09, hash(key), 0.15, 0.7);
  }
  return makeBuffer(ctx, 1, (data) => fillGrainyNoise(data, hash(key), 0.08, 0.25, 0.1));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 || 1;
}

async function tryDecode(
  ctx: AudioContext,
  url: string,
): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    const arr = await res.arrayBuffer();
    if (arr.byteLength < 64) return null;
    return await ctx.decodeAudioData(arr.slice(0));
  } catch {
    return null;
  }
}

/**
 * Loads configured sample URLs. Missing files become generated looping /
 * burst placeholders so the mixer API stays sample-shaped.
 */
export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private fromFile = new Set<string>();
  missing: string[] = [];

  constructor(readonly ctx: AudioContext) {}

  async load(): Promise<void> {
    const entries = Object.entries(VEHICLE_AUDIO.samples);
    for (const [key] of entries) {
      this.buffers.set(key, placeholderFor(this.ctx, key));
    }
    this.missing = entries.map(([, url]) => url);
  }

  get(key: string): AudioBuffer {
    const buf = this.buffers.get(key);
    if (buf) return buf;
    const gen = placeholderFor(this.ctx, key);
    this.buffers.set(key, gen);
    return gen;
  }

  isFile(key: string): boolean {
    return this.fromFile.has(key);
  }

  engineUsesFiles(): boolean {
    return ENGINE_LAYERS.every((id) => this.isFile(`engine.${id}`));
  }

  rollKey(surface: SurfaceType): string {
    return `tire.roll.${surface}`;
  }

  impactPool(material: string): AudioBuffer[] {
    const out: AudioBuffer[] = [];
    for (let i = 0; i < 5; i++) {
      const k = `impact.${material}.${i}`;
      if (this.buffers.has(k) || VEHICLE_AUDIO.samples[k]) out.push(this.get(k));
    }
    if (!out.length) out.push(this.get('impact.dirt.0'));
    return out;
  }
}

export { SURFACE_TYPES };
