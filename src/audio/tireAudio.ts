import { AUDIO } from '../config';
import type { AudioGraph } from './graph';
import type { SampleBank } from './samples';
import { LoopVoice } from './voices';
import {
  rollingGain,
  slipSkidGain,
  skidMotionGate,
  brakeMechanicalGain,
  skidCharacter,
  surfaceTypeFromId,
  audibleWheelSlip,
} from './mapping';
import type { SurfaceType } from './types';
import type { WheelVisual } from '../physics/vehicle';

type WheelVoices = {
  rollA: LoopVoice;
  rollB: LoopVoice;
  skid: LoopVoice;
  surface: SurfaceType;
  flip: boolean;
};

export class TireAudio {
  private wheels: WheelVoices[] = [];
  private brake: LoopVoice;
  private squeal: AudioBuffer;
  private grit: AudioBuffer;
  rollingLevels = [0, 0, 0, 0];
  skidLevel = 0;
  brakeLevel = 0;
  surface: SurfaceType = 'tarmac';

  constructor(
    private graph: AudioGraph,
    private bank: SampleBank,
  ) {
    this.squeal = bank.get('tire.skid.squeal');
    this.grit = bank.get('tire.skid.grit');
    for (let i = 0; i < 4; i++) {
      const dest = graph.tirePanners[i].input;
      const rollA = new LoopVoice(graph.ctx, dest);
      const rollB = new LoopVoice(graph.ctx, dest);
      const skid = new LoopVoice(graph.ctx, dest);
      rollA.setBuffer(bank.get('tire.roll.tarmac'));
      rollB.setBuffer(bank.get('tire.roll.dirt'));
      skid.setBuffer(this.squeal);
      this.wheels.push({
        rollA, rollB, skid, surface: 'tarmac', flip: false,
      });
    }
    this.brake = new LoopVoice(graph.ctx, graph.sfxBus);
    this.brake.setBuffer(bank.get('brake.mechanical'));
  }

  update(opts: {
    wheels: WheelVisual[];
    speedMs: number;
    brake: number;
    throttle: number;
    radius: number;
    now: number;
    smoothedSlip: number;
    dominant: SurfaceType;
  }): void {
    const { wheels, speedMs, brake, throttle, radius, now, smoothedSlip, dominant } = opts;
    this.surface = dominant;
    let motionGate = skidMotionGate(speedMs, 0, radius);
    for (const w of wheels) {
      motionGate = Math.max(motionGate, skidMotionGate(speedMs, w.omega, radius));
    }
    const skidG = slipSkidGain(smoothedSlip) * motionGate;
    this.skidLevel = skidG;
    let anyGrounded = false;
    let maxRoll = 0;

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const voice = this.wheels[i];
      if (!w || !voice) continue;
      if (w.grounded) anyGrounded = true;
      const surf = surfaceTypeFromId(w.surfaceId);
      if (surf !== voice.surface) {
        voice.surface = surf;
        voice.flip = !voice.flip;
        const buf = this.bank.get(this.bank.rollKey(surf));
        (voice.flip ? voice.rollB : voice.rollA).setBuffer(buf);
      }
      const roll = rollingGain(speedMs, w.omega, radius, w.grounded);
      this.rollingLevels[i] = roll;
      maxRoll = Math.max(maxRoll, roll);
      const a = voice.flip ? 0 : 1;
      voice.rollA.setGain(roll * a * 0.38, now, 0.07);
      voice.rollB.setGain(roll * (1 - a) * 0.38, now, 0.07);
      const rate = 0.7 + Math.min(1.4, Math.abs(speedMs) * 0.035 + Math.abs(w.omega) * 0.004);
      voice.rollA.setRate(rate, now, 0.08);
      voice.rollB.setRate(rate, now, 0.08);

      const locking = brake > 0.45 && Math.abs(w.omega) * radius < Math.abs(speedMs) * 0.55 && Math.abs(speedMs) > 4;
      const char = locking ? 'grit' : skidCharacter(surf);
      voice.skid.setBuffer(char === 'squeal' ? this.squeal : this.grit);
      const wheelSlip = audibleWheelSlip({
        slip: w.slip,
        slipLat: w.slipLat,
        speedMs,
        omega: w.omega,
        radius,
        brake,
        throttle,
        grounded: w.grounded,
      });
      const localSkid = slipSkidGain(wheelSlip) * motionGate;
      const mix = Math.max(localSkid, skidG * (w.grounded ? 0.45 : 0));
      const skidVol = char === 'squeal' ? mix * 0.5 : mix * 0.38;
      voice.skid.setGain(skidVol, now, 0.05);
      voice.skid.setRate(0.85 + mix * 0.3, now, 0.06);
    }

    const brakeG = brakeMechanicalGain(brake, speedMs, skidG, anyGrounded);
    this.brakeLevel = brakeG;
    this.brake.setGain(brakeG * 0.4 * AUDIO.sfx, now, 0.045);
    this.brake.setRate(0.78 + Math.min(0.45, Math.abs(speedMs) * 0.018), now, 0.08);
    void maxRoll;
  }
}
