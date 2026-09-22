import { AUDIO } from '../config';
import type { AudioGraph } from './graph';

/** Wind + river beds. Not vehicle-event mapping; kept from the old SFX bus. */
export class AmbientAudio {
  private wind: GainNode;
  private windFilter: BiquadFilterNode;
  private river: GainNode;

  constructor(graph: AudioGraph) {
    const ctx = graph.ctx;
    const noise = makeNoise(ctx, 2);

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 380;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.07;
    loop(ctx, noise, 0.85).connect(this.windFilter);
    this.windFilter.connect(this.wind);
    this.wind.connect(graph.ambientBus);

    const riverF = ctx.createBiquadFilter();
    riverF.type = 'lowpass';
    riverF.frequency.value = 520;
    riverF.Q.value = 0.6;
    this.river = ctx.createGain();
    this.river.gain.value = 0.1;
    loop(ctx, noise, 0.7).connect(riverF);
    riverF.connect(this.river);
    this.river.connect(graph.ambientBus);
  }

  update(speedMs: number, distToRiver: number, now: number): void {
    const w = 0.045 + Math.min(0.48, Math.abs(speedMs) * 0.01);
    this.wind.gain.setTargetAtTime(w, now, 0.12);
    this.windFilter.frequency.setTargetAtTime(260 + Math.abs(speedMs) * 12, now, 0.15);
    const riverVol = Math.max(0, 1 - Math.abs(distToRiver) / 90) * 0.38;
    this.river.gain.setTargetAtTime(riverVol * (AUDIO.ambience > 0 ? 1 : 0), now, 0.25);
  }
}

function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function loop(ctx: AudioContext, buf: AudioBuffer, rate: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start();
  return src;
}
