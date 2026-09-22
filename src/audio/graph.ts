import { AUDIO } from '../config';
import { VEHICLE_AUDIO } from './config';
import type { Vec3 } from './types';

export type PannerHandle = {
  input: GainNode;
  panner: PannerNode;
  setPosition: (p: Vec3, now: number) => void;
};

function setListenerPose(
  ctx: AudioContext,
  pos: Vec3,
  forward: Vec3,
  up: Vec3,
  now: number,
): void {
  const L = ctx.listener;
  const t = 0.02;
  const lx = L as AudioListener & {
    positionX?: AudioParam;
    positionY?: AudioParam;
    positionZ?: AudioParam;
    forwardX?: AudioParam;
    forwardY?: AudioParam;
    forwardZ?: AudioParam;
    upX?: AudioParam;
    upY?: AudioParam;
    upZ?: AudioParam;
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (
      fx: number, fy: number, fz: number,
      ux: number, uy: number, uz: number,
    ) => void;
  };
  if (lx.positionX && lx.forwardX && lx.upX) {
    lx.positionX.setTargetAtTime(pos.x, now, t);
    lx.positionY!.setTargetAtTime(pos.y, now, t);
    lx.positionZ!.setTargetAtTime(pos.z, now, t);
    lx.forwardX.setTargetAtTime(forward.x, now, t);
    lx.forwardY!.setTargetAtTime(forward.y, now, t);
    lx.forwardZ!.setTargetAtTime(forward.z, now, t);
    lx.upX.setTargetAtTime(up.x, now, t);
    lx.upY!.setTargetAtTime(up.y, now, t);
    lx.upZ!.setTargetAtTime(up.z, now, t);
  } else {
    lx.setPosition?.(pos.x, pos.y, pos.z);
    lx.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

function makePanner(ctx: AudioContext, dest: AudioNode): PannerHandle {
  const input = ctx.createGain();
  input.gain.value = 1;
  const panner = ctx.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = VEHICLE_AUDIO.spatial.refDistance;
  panner.maxDistance = VEHICLE_AUDIO.spatial.maxDistance;
  panner.rolloffFactor = VEHICLE_AUDIO.spatial.rolloff;
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  input.connect(panner);
  panner.connect(dest);
  return {
    input,
    panner,
    setPosition(p, now) {
      const t = 0.025;
      if (panner.positionX) {
        panner.positionX.setTargetAtTime(p.x, now, t);
        panner.positionY.setTargetAtTime(p.y, now, t);
        panner.positionZ.setTargetAtTime(p.z, now, t);
      } else {
        panner.setPosition(p.x, p.y, p.z);
      }
    },
  };
}

/**
 * Persistent Web Audio graph: master buses, interior filter, 3D panners.
 * Loops and one-shots attach to these nodes; nothing is rebuilt per frame.
 */
export class AudioGraph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly engineBus: GainNode;
  readonly sfxBus: GainNode;
  readonly ambientBus: GainNode;
  readonly vehicleIn: GainNode;
  readonly lpf: BiquadFilterNode;
  readonly cabin: BiquadFilterNode;

  readonly enginePanner: PannerHandle;
  readonly exhaustPanner: PannerHandle;
  readonly tirePanners: PannerHandle[];
  readonly scrapePanner: PannerHandle;
  readonly impactPanners: PannerHandle[];
  private impactCursor = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = AUDIO.master;
    this.master.connect(ctx.destination);

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = VEHICLE_AUDIO.interior.exteriorCutoffHz;
    this.lpf.Q.value = 0.7;

    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'peaking';
    this.cabin.frequency.value = VEHICLE_AUDIO.interior.cabinPeakHz;
    this.cabin.Q.value = 1.1;
    this.cabin.gain.value = 0;

    this.vehicleIn = ctx.createGain();
    this.vehicleIn.gain.value = 1;
    this.vehicleIn.connect(this.lpf);
    this.lpf.connect(this.cabin);
    this.cabin.connect(this.master);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = AUDIO.engine;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = AUDIO.sfx;
    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = AUDIO.ambience;
    this.ambientBus.connect(this.master);

    this.enginePanner = makePanner(ctx, this.vehicleIn);
    this.exhaustPanner = makePanner(ctx, this.vehicleIn);
    this.tirePanners = [
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
    ];
    this.scrapePanner = makePanner(ctx, this.vehicleIn);
    this.impactPanners = [
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
      makePanner(ctx, this.vehicleIn),
    ];

    this.engineBus.connect(this.enginePanner.input);
    this.sfxBus.connect(this.vehicleIn);
  }

  nextImpactPanner(): PannerHandle {
    const p = this.impactPanners[this.impactCursor % this.impactPanners.length];
    this.impactCursor++;
    return p;
  }

  setInterior(amount: number, now: number): void {
    const t = VEHICLE_AUDIO.interior;
    const cutoff = t.exteriorCutoffHz + (t.cutoffHz - t.exteriorCutoffHz) * amount;
    this.lpf.frequency.setTargetAtTime(cutoff, now, 0.08);
    this.cabin.gain.setTargetAtTime(t.cabinPeakGainDb * amount, now, 0.08);
  }

  setBusGains(now: number): void {
    this.master.gain.setTargetAtTime(AUDIO.master, now, 0.15);
    this.engineBus.gain.setTargetAtTime(AUDIO.engine, now, 0.15);
    this.sfxBus.gain.setTargetAtTime(AUDIO.sfx, now, 0.15);
    this.ambientBus.gain.setTargetAtTime(AUDIO.ambience, now, 0.15);
  }

  setListener(pos: Vec3, forward: Vec3, up: Vec3, now: number): void {
    setListenerPose(this.ctx, pos, forward, up, now);
  }
}
