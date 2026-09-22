import type { Vec3 } from './types';
import type { PannerHandle } from './graph';

/** Persistent looping source. Gain/rate only after start — never restart per frame. */
export class LoopVoice {
  readonly gain: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private started = false;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(dest);
  }

  setBuffer(buf: AudioBuffer, restart = false): void {
    if (this.buffer === buf && this.started && !restart) return;
    this.buffer = buf;
    if (this.src) {
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.gain);
    src.start();
    this.src = src;
    this.started = true;
  }

  setGain(value: number, now: number, tau = 0.05): void {
    this.gain.gain.setTargetAtTime(Math.max(0, value), now, tau);
  }

  setRate(value: number, now: number, tau = 0.06): void {
    if (!this.src) return;
    this.src.playbackRate.setTargetAtTime(
      Math.max(0.25, Math.min(3, value)),
      now,
      tau,
    );
  }

  stop(): void {
    if (this.src) {
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
    this.started = false;
  }
}

export function playOneShot(
  ctx: AudioContext,
  buffer: AudioBuffer,
  dest: AudioNode,
  opts: {
    gain?: number;
    rate?: number;
    offset?: number;
    duration?: number;
  } = {},
): void {
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = opts.rate ?? 1;
  const g = ctx.createGain();
  const gain = Math.max(0.0001, opts.gain ?? 0.5);
  g.gain.setValueAtTime(gain, now);
  const dur = opts.duration ?? Math.max(0.05, buffer.duration / src.playbackRate.value);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(g);
  g.connect(dest);
  const offset = Math.max(0, Math.min(opts.offset ?? 0, Math.max(0, buffer.duration - 0.02)));
  src.start(now, offset);
  src.stop(now + dur + 0.03);
}

export function playOneShotAt(
  ctx: AudioContext,
  buffer: AudioBuffer,
  panner: PannerHandle,
  position: Vec3,
  opts: { gain?: number; rate?: number; offset?: number; duration?: number } = {},
): void {
  panner.setPosition(position, ctx.currentTime);
  playOneShot(ctx, buffer, panner.input, opts);
}
