import type { CameraMode } from '../camera/cameras';
import type { PowertrainEvent } from '../physics/transmission';
import type { VehicleSnapshot } from '../physics/vehicle';
import type { ChassisContact } from '../physics/contacts';
import { ENGINE } from '../config';
import { AudioGraph } from './graph';
import { SampleBank } from './samples';
import { EngineAudio } from './engineLayers';
import { TireAudio } from './tireAudio';
import { BodyAudio } from './bodyAudio';
import { AmbientAudio } from './ambience';
import { SmoothParam } from './smoothing';
import { VEHICLE_AUDIO } from './config';
import { LoopVoice } from './voices';
import {
  clamp01,
  dominantSurface,
  engineLoadMode,
  normalizedRPM,
  normalizedSpeed,
  audibleWheelSlip,
} from './mapping';
import type {
  AudioDebugSnapshot,
  EngineLoadMode,
  VehicleAudioParams,
  Vec3,
} from './types';

export type VehicleAudioFrame = {
  snapshot: VehicleSnapshot;
  throttle: number;
  brake: number;
  clutch: number;
  cameraMode: CameraMode;
  listenerPos: Vec3;
  listenerForward: Vec3;
  listenerUp: Vec3;
  distToWater: number;
  dt: number;
  wheelRadius: number;
};

function quatRotate(
  q: { x: number; y: number; z: number; w: number },
  v: Vec3,
): Vec3 {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

function plus(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Gathers vehicle/game state and drives layered 3D vehicle audio.
 * Physics remains read-only.
 */
export class VehicleAudioController {
  private graph: AudioGraph | null = null;
  private bank: SampleBank | null = null;
  private engine: EngineAudio | null = null;
  private tires: TireAudio | null = null;
  private body: BodyAudio | null = null;
  private ambient: AmbientAudio | null = null;
  private clutchVoice: LoopVoice | null = null;
  private events: PowertrainEvent[] = [];
  private contacts: ChassisContact[] = [];
  private rpmS = new SmoothParam(ENGINE.idleRPM, 14, 8);
  private throttleS = new SmoothParam(0, 16, 4.5);
  private loadS = new SmoothParam(0, 12, 3.8);
  private slipS = new SmoothParam(0, 10, 5);
  private interiorS = new SmoothParam(0, 6, 6);
  private speedS = new SmoothParam(0, 10, 8);
  private params: VehicleAudioParams | null = null;
  missingAssets: string[] = [];
  ready = false;

  async start(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'suspended') await ctx.resume();
    this.graph = new AudioGraph(ctx);
    this.bank = new SampleBank(ctx);
    await this.bank.load();
    this.missingAssets = this.bank.missing;
    this.engine = new EngineAudio(this.graph, this.bank);
    await this.engine.init();
    this.tires = new TireAudio(this.graph, this.bank);
    this.body = new BodyAudio(this.graph, this.bank);
    this.ambient = new AmbientAudio(this.graph);
    this.clutchVoice = new LoopVoice(ctx, this.graph.enginePanner.input);
    this.clutchVoice.setBuffer(this.bank.get('tire.skid.grit'));
    this.ready = true;
  }

  async resume(): Promise<void> {
    const ctx = this.graph?.ctx;
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }

  get context(): AudioContext | null {
    return this.graph?.ctx ?? null;
  }

  pushEvents(events: PowertrainEvent[]): void {
    if (events.length) this.events.push(...events);
  }

  pushContacts(contacts: ChassisContact[]): void {
    if (contacts.length) this.contacts.push(...contacts);
  }

  update(frame: VehicleAudioFrame): void {
    if (!this.ready || !this.graph || !this.engine || !this.tires || !this.body || !this.ambient) {
      return;
    }
    const { snapshot: snap, dt } = frame;
    const now = this.graph.ctx.currentTime;
    this.graph.setBusGains(now);
    this.graph.setListener(frame.listenerPos, frame.listenerForward, frame.listenerUp, now);

    const interiorTarget = frame.cameraMode === 'hood' ? 1 : 0;
    const interior = this.interiorS.tick(interiorTarget, dt);
    this.graph.setInterior(interior, now);

    const rpm = this.rpmS.tick(snap.rpm, dt);
    const throttle = this.throttleS.tick(frame.throttle, dt);
    const blendedLoad = clamp01(snap.engineLoad * 0.65 + frame.throttle * 0.45);
    const load = this.loadS.tick(blendedLoad, dt);
    const speed = this.speedS.tick(snap.speedMs, dt);

    let longSlip = 0;
    let latSlip = 0;
    let avgSlip = 0;
    let groundedN = 0;
    let audioSlip = 0;
    const audioBrake = Math.max(frame.brake, snap.handbrake ? 0.62 : 0);
    for (const w of snap.wheels) {
      longSlip = Math.max(longSlip, w.slip);
      latSlip = Math.max(latSlip, w.slipLat);
      if (w.grounded) {
        avgSlip += Math.max(w.slip, w.slipLat);
        groundedN++;
      }
      audioSlip = Math.max(
        audioSlip,
        audibleWheelSlip({
          slip: w.slip,
          slipLat: w.slipLat,
          speedMs: snap.speedMs,
          omega: w.omega,
          radius: frame.wheelRadius,
          brake: audioBrake,
          throttle: frame.throttle,
          grounded: w.grounded,
        }),
      );
    }
    avgSlip = groundedN ? avgSlip / groundedN : 0;
    const slip = this.slipS.tick(audioSlip, dt);
    const surface = dominantSurface(snap.wheels);
    const isGrounded = groundedN > 0;

    const loadMode: EngineLoadMode = engineLoadMode({
      throttle: frame.throttle,
      rpm: snap.rpm,
      speedMs: snap.speedMs,
      gear: snap.gear,
      clutchLocked: snap.clutchLocked,
      engineLoad: snap.engineLoad,
    });

    const enginePos = plus(
      snap.position,
      quatRotate(snap.rotation, VEHICLE_AUDIO.engineOffset),
    );
    const exhaustPos = plus(
      snap.position,
      quatRotate(snap.rotation, VEHICLE_AUDIO.exhaustOffset),
    );
    this.graph.enginePanner.setPosition(enginePos, now);
    this.graph.exhaustPanner.setPosition(exhaustPos, now);
    for (let i = 0; i < 4; i++) {
      const w = snap.wheels[i];
      if (w) this.graph.tirePanners[i].setPosition(w.position, now);
    }

    const events = this.events;
    this.events = [];
    for (const ev of events) {
      if (ev.type === 'shift' && ev.ok) {
        this.body.playShift();
        this.engine.duckShift(now);
      } else if (ev.type === 'grind' || (ev.type === 'shift' && !ev.ok)) {
        this.body.playGrind();
      } else if (ev.type === 'stall') {
        this.engine.beginStall(now);
      } else if (ev.type === 'start') {
        this.engine.playSolenoidEngage();
      } else if (ev.type === 'ignitionDenied') {
        this.engine.playIgnitionDenied();
      }
    }
    this.engine.notifyState(snap.engineState, now);
    this.engine.update({
      rpm: snap.rpm,
      throttle,
      load,
      loadMode,
      state: snap.engineState,
      fuelCut: snap.fuelCut,
      interior,
      coldStart: snap.coldStart,
      now,
    });

    this.tires.update({
      wheels: snap.wheels,
      speedMs: speed,
      brake: audioBrake,
      throttle: frame.throttle,
      radius: frame.wheelRadius,
      now,
      smoothedSlip: slip,
      dominant: surface,
    });

    const contacts = this.contacts;
    this.contacts = [];
    let collisionDir: Vec3 = { x: 0, y: 1, z: 0 };
    let bestI = 0;
    for (const c of contacts) {
      if (c.intensity >= bestI) {
        bestI = c.intensity;
        collisionDir = c.direction;
      }
    }
    const collisionImpact = this.body.processContacts(contacts, now);
    const suspensionImpact = this.body.processSuspension(snap.wheels, now);

    const slipping = frame.clutch < 0.92 && snap.clutchSlip > 6;
    const clutchAmt = slipping ? Math.min(0.28, snap.clutchSlip * 0.009) : 0;
    this.clutchVoice?.setGain(clutchAmt, now, 0.04);
    this.clutchVoice?.setRate(0.9 + snap.clutchSlip * 0.01, now, 0.05);

    this.ambient.update(speed, frame.distToWater, now);

    this.params = {
      speed,
      normalizedSpeed: normalizedSpeed(speed),
      rpm,
      normalizedRPM: normalizedRPM(rpm),
      throttle,
      brake: audioBrake,
      gear: snap.gear,
      engineLoad: load,
      wheelSlip: slip,
      averageWheelSlip: avgSlip,
      longitudinalSlip: longSlip,
      lateralSlip: latSlip,
      surfaceType: surface,
      suspensionImpact,
      collisionImpact,
      collisionDirection: collisionDir,
      isGrounded,
      scrapeIntensity: this.body.scrapeLevel,
      loadMode,
      engineState: snap.engineState,
      fuelCut: snap.fuelCut,
      clutchSlip: snap.clutchSlip,
      clutchPedal: frame.clutch,
    };
  }

  debugSnapshot(): AudioDebugSnapshot | null {
    if (!this.params || !this.engine || !this.tires || !this.body) return null;
    const layers: Record<string, number> = {
      ...this.engine.layerGains,
      combust: this.engine.combustGain,
      starter: this.engine.starterGain,
      worklet: this.engine.usingWorklet ? 1 : 0,
      rolling: Math.max(...this.tires.rollingLevels),
      skid: this.tires.skidLevel,
      brake: this.tires.brakeLevel,
      scrape: this.body.scrapeLevel,
    };
    return {
      params: this.params,
      layers,
      interior: this.interiorS.value > 0.5,
    };
  }
}

export { VehicleAudioController as AudioEngine };
export { VehicleAudioController as EngineSound };
