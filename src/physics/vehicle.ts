import RAPIER, { World, RigidBody, Ray, type Collider } from '@dimforge/rapier3d-compat';
import {
  SUSPENSION, STEERING, TIRES, SURFACES, TRANSMISSION,
  type VehicleSpec,
} from '../config';
import { Powertrain, PowertrainEvent } from './transmission';
import { Brakes } from './brakes';
import { tireForces, surfaceRolling } from './tires';
import { applyHydrodynamics } from './hydro';

/** Pedal/steer state consumed each physics step (from Input or tests). */
export type VehicleControls = {
  throttle: number;
  brake: number;
  clutch: number;
  steer: number; // -1..+1, left positive
  handbrake: boolean;
};

export type WheelVisual = {
  position: { x: number; y: number; z: number };
  steer: number;
  spin: number;
  compression: number;
  /** Suspension length change rate (m/s); positive = compressing. */
  compressionVel: number;
  grounded: boolean;
  surfaceId: number;
  slip: number;
  slipLat: number;
  load: number;
  omega: number;
};

export type VehicleSnapshot = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  linearVel: { x: number; y: number; z: number };
  speedMs: number;
  wheels: WheelVisual[];
  rpm: number;
  gear: number;
  gearLabel: string;
  engineState: string;
  fuelCut: boolean;
  engineLoad: number;
  clutchSlip: number;
  clutchLocked: boolean;
  handbrake: boolean;
  brakeTemp: number;
  steerAngle: number;
  stalled: boolean;
  /** 0..1 cold-start idle stumble. */
  coldStart: number;
};

type WheelInternal = {
  attach: { x: number; y: number; z: number };
  isFront: boolean;
  isLeft: boolean;
  prevLength: number;
  omega: number;
  spin: number;
  steer: number;
  compression: number;
  compressionVel: number;
  grounded: boolean;
  surfaceId: number;
  slip: number;
  slipLat: number;
  load: number;
  worldPos: { x: number; y: number; z: number };
};

function quatRotate(q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
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

function quatTransformPoint(
  q: { x: number; y: number; z: number; w: number },
  p: { x: number; y: number; z: number },
  t: { x: number; y: number; z: number },
) {
  const r = quatRotate(q, p);
  return { x: r.x + t.x, y: r.y + t.y, z: r.z + t.z };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Custom 4-wheel raycast vehicle on a Rapier dynamic chassis.
 * Forward = -Z, up = +Y. AWD via TRANSMISSION.driveBiasRear.
 *
 * Wiring (main):
 *   const v = new Vehicle(world, spawn, spec);
 *   v.setGetSurface((x, z) => terrain.surfaceAt(x, z));
 *   // fixed step: v.handleActions(...); v.step(world, dt, controls); world.step();
 *   // render: const pose = v.getInterpolated(alpha); carMesh.update(...);
 */
export class Vehicle {
  body: RigidBody;
  chassisCollider: Collider;
  spec: VehicleSpec;
  powertrain = new Powertrain();
  brakes = new Brakes();
  wheels: WheelInternal[];

  private steerAngle = 0;
  private pendingEvents: PowertrainEvent[] = [];
  private stallImpulsePending = false;
  /** Injected surface lookup; defaults to tarmac (0). */
  private getSurface: (x: number, z: number) => number = () => 0;
  /** Water surface Y, or -Infinity off-patch. Isolated hydro in applyHydrodynamics. */
  private getWaterHeight: (x: number, z: number) => number = () => Number.NEGATIVE_INFINITY;
  private lastClutchSlip = 0;
  private lastClutchLocked = false;
  private lastHandbrake = false;

  prevPos = { x: 0, y: 0, z: 0 };
  prevRot = { x: 0, y: 0, z: 0, w: 1 };
  currPos = { x: 0, y: 0, z: 0 };
  currRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    world: World,
    spawn: { x: number; y: number; z: number },
    spec: VehicleSpec,
  ) {
    this.spec = spec;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setLinearDamping(0.05)
      .setAngularDamping(0.35);
    this.body = world.createRigidBody(desc);

    const he = spec.halfExtents;
    const collider = RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z)
      .setFriction(0.4)
      .setRestitution(0.05)
      .setDensity(0);
    this.chassisCollider = world.createCollider(collider, this.body);

    this.body.setAdditionalMassProperties(
      spec.mass,
      spec.comOffset,
      spec.inertia,
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    const A = spec.attach;
    this.wheels = [
      { attach: { x: -A.halfTrack, y: A.y, z: A.frontZ }, isFront: true, isLeft: true },
      { attach: { x: A.halfTrack, y: A.y, z: A.frontZ }, isFront: true, isLeft: false },
      { attach: { x: -A.halfTrack, y: A.y, z: A.rearZ }, isFront: false, isLeft: true },
      { attach: { x: A.halfTrack, y: A.y, z: A.rearZ }, isFront: false, isLeft: false },
    ].map((w) => ({
      ...w,
      prevLength: SUSPENSION.restLength,
      omega: 0,
      spin: 0,
      steer: 0,
      compression: 0,
      compressionVel: 0,
      grounded: false,
      surfaceId: 0,
      slip: 0,
      slipLat: 0,
      load: 0,
      worldPos: { x: spawn.x, y: spawn.y, z: spawn.z },
    }));

    this.syncPose(true);
  }

  dispose(world: World) {
    world.removeRigidBody(this.body);
  }

  /** Inject terrain surface id lookup used per wheel contact. */
  setGetSurface(fn: (x: number, z: number) => number) {
    this.getSurface = fn;
  }

  setWaterHeightAt(fn: (x: number, z: number) => number) {
    this.getWaterHeight = fn;
  }

  /** @deprecated alias — prefer setGetSurface */
  setSurfaceSampler(fn: (x: number, z: number) => number) {
    this.setGetSurface(fn);
  }

  syncPose(init = false) {
    const t = this.body.translation();
    const r = this.body.rotation();
    if (init) {
      this.prevPos = { x: t.x, y: t.y, z: t.z };
      this.prevRot = { x: r.x, y: r.y, z: r.z, w: r.w };
    } else {
      this.prevPos = { ...this.currPos };
      this.prevRot = { ...this.currRot };
    }
    this.currPos = { x: t.x, y: t.y, z: t.z };
    this.currRot = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  getInterpolated(alpha: number) {
    const a = Math.max(0, Math.min(1, alpha));
    return {
      position: {
        x: lerp(this.prevPos.x, this.currPos.x, a),
        y: lerp(this.prevPos.y, this.currPos.y, a),
        z: lerp(this.prevPos.z, this.currPos.z, a),
      },
      rotation: slerpQuat(this.prevRot, this.currRot, a),
    };
  }

  getSteerAngle() {
    return this.steerAngle;
  }

  getWheelVisuals(): WheelVisual[] {
    return this.wheels.map((w) => ({
      position: { ...w.worldPos },
      steer: w.steer,
      spin: w.spin,
      compression: w.compression,
      compressionVel: w.compressionVel,
      grounded: w.grounded,
      surfaceId: w.surfaceId,
      slip: w.slip,
      slipLat: w.slipLat,
      load: w.load,
      omega: w.omega,
    }));
  }

  consumeEvents(): PowertrainEvent[] {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  handleActions(actions: string[], clutch: number) {
    for (const a of actions) {
      switch (a) {
        case 'shiftUp': this.powertrain.shiftUp(clutch); break;
        case 'shiftDown': this.powertrain.shiftDown(clutch); break;
        case 'neutral': this.powertrain.requestGear(0, clutch); break;
        case 'reverse': this.powertrain.requestGear(-1, clutch); break;
        case 'gear1': this.powertrain.requestGear(1, clutch); break;
        case 'gear2': this.powertrain.requestGear(2, clutch); break;
        case 'gear3': this.powertrain.requestGear(3, clutch); break;
        case 'gear4': this.powertrain.requestGear(4, clutch); break;
        case 'gear5': this.powertrain.requestGear(5, clutch); break;
        case 'ignition':
          // R is the usual reverse key. Only crank when the engine is dead.
          if (this.powertrain.engine.running) {
            this.powertrain.requestGear(-1, clutch);
          } else {
            this.powertrain.tryIgnition(clutch);
          }
          break;
      }
    }
  }

  /**
   * Apply suspension / tire / powertrain forces for one fixed step.
   * Call before `world.step()`.
   */
  step(world: World, dt: number, input: VehicleControls) {
    this.syncPose(false);
    this.lastHandbrake = input.handbrake;

    const t = this.body.translation();
    const q = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();

    const forward = quatRotate(q, { x: 0, y: 0, z: -1 });
    const up = quatRotate(q, { x: 0, y: 1, z: 0 });
    const right = quatRotate(q, { x: 1, y: 0, z: 0 });

    const speedMs = Math.hypot(lv.x, lv.z);
    const maxSteer = lerp(
      STEERING.maxAngleLow,
      STEERING.maxAngleHigh,
      Math.min(1, speedMs / STEERING.speedForHigh),
    );
    this.steerAngle = input.steer * maxSteer;

    const R = this.spec.wheelRadius;
    const rayLen = SUSPENSION.restLength + SUSPENSION.maxTravel + R;
    const compressions: number[] = [];

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.steer = w.isFront ? this.steerAngle : 0;

      const attachWorld = quatTransformPoint(q, w.attach, t);
      const down = { x: -up.x, y: -up.y, z: -up.z };
      const origin = {
        x: attachWorld.x + up.x * 0.05,
        y: attachWorld.y + up.y * 0.05,
        z: attachWorld.z + up.z * 0.05,
      };

      const ray = new Ray(origin, down);
      const hit = world.castRayAndGetNormal(
        ray,
        rayLen + 0.05,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      );

      if (hit) {
        const toi = hit.timeOfImpact;
        const dist = toi - 0.05;
        const suspLen = Math.max(0, dist - R);
        const compression = SUSPENSION.restLength - suspLen;
        const clampedComp = Math.max(0, Math.min(SUSPENSION.maxTravel, compression));
        const compressionVel = (w.prevLength - suspLen) / dt;
        w.prevLength = suspLen;
        w.compressionVel = compressionVel;

        let springF = SUSPENSION.stiffness * clampedComp;
        const damp = compressionVel > 0
          ? SUSPENSION.damperCompression * compressionVel
          : SUSPENSION.damperRebound * compressionVel;
        springF += damp;
        if (springF < 0) springF = 0;

        this.body.applyImpulseAtPoint(
          { x: up.x * springF * dt, y: up.y * springF * dt, z: up.z * springF * dt },
          attachWorld,
          true,
        );

        w.grounded = true;
        w.compression = clampedComp / SUSPENSION.maxTravel;
        w.load = springF;
        compressions[i] = clampedComp;

        const hitPoint = {
          x: origin.x + down.x * toi,
          y: origin.y + down.y * toi,
          z: origin.z + down.z * toi,
        };
        w.worldPos = {
          x: hitPoint.x + up.x * R,
          y: hitPoint.y + up.y * R,
          z: hitPoint.z + up.z * R,
        };
        w.surfaceId = this.getSurface(hitPoint.x, hitPoint.z);
      } else {
        w.grounded = false;
        w.compression = 0;
        w.compressionVel = 0;
        w.load = 0;
        w.prevLength = SUSPENSION.restLength;
        compressions[i] = 0;
        w.worldPos = quatTransformPoint(
          q,
          { x: w.attach.x, y: w.attach.y - SUSPENSION.restLength, z: w.attach.z },
          t,
        );
        w.surfaceId = 0;
      }
    }

    this.applyAntiRoll(0, 1, compressions, up, q, t, dt);
    this.applyAntiRoll(2, 3, compressions, up, q, t, dt);

    const rearBias = Math.max(0, Math.min(1, TRANSMISSION.driveBiasRear ?? 1));
    const frontBias = 1 - rearBias;
    const drivenOmega =
      (this.wheels[0].omega + this.wheels[1].omega) * 0.5 * frontBias +
      (this.wheels[2].omega + this.wheels[3].omega) * 0.5 * rearBias;
    const pt = this.powertrain.update(dt, input.throttle, input.clutch, drivenOmega);
    this.pendingEvents.push(...pt.events);
    this.lastClutchSlip = pt.clutchSlip;
    this.lastClutchLocked = pt.clutchLocked;
    if (pt.events.some((e) => e.type === 'stall')) this.stallImpulsePending = true;

    const wheelAbs = this.wheels.map((w) => Math.abs(w.omega));
    const brakeOut = this.brakes.update(dt, input.brake, input.handbrake, wheelAbs, speedMs);

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded || w.load < 1) {
        w.slip = 0;
        w.slipLat = 0;
        w.omega *= 0.995;
        w.spin += w.omega * dt;
        continue;
      }

      const steerQ = axisAngleQuat(up, w.steer);
      const tireForward = quatRotate(steerQ, forward);
      const tireRight = quatRotate(steerQ, right);

      const rel = {
        x: w.worldPos.x - t.x,
        y: w.worldPos.y - t.y,
        z: w.worldPos.z - t.z,
      };
      const vel = {
        x: lv.x + (av.y * rel.z - av.z * rel.y),
        y: lv.y + (av.z * rel.x - av.x * rel.z),
        z: lv.z + (av.x * rel.y - av.y * rel.x),
      };

      const vLong = vel.x * tireForward.x + vel.y * tireForward.y + vel.z * tireForward.z;
      const vLat = vel.x * tireRight.x + vel.y * tireRight.y + vel.z * tireRight.z;

      const R = this.spec.wheelRadius;
      const slipDenom = Math.max(TIRES.slipDenomFloor, Math.abs(vLong));
      const slipRatio = (w.omega * R - vLong) / slipDenom;
      const slipAngle = Math.atan2(vLat, Math.max(TIRES.slipDenomFloor, Math.abs(vLong)));

      const forces = tireForces(slipRatio, slipAngle, w.load, w.surfaceId, speedMs);
      w.slip = Math.abs(slipRatio);
      w.slipLat = Math.abs(slipAngle);

      const applyY = TIRES.rollInfluence * R;
      const applyAt = {
        x: w.worldPos.x + up.x * applyY,
        y: w.worldPos.y + up.y * applyY,
        z: w.worldPos.z + up.z * applyY,
      };

      const Fx = forces.long;
      const Fy = forces.lat;
      this.body.applyImpulseAtPoint(
        {
          x: (tireForward.x * Fx + tireRight.x * Fy) * dt,
          y: (tireForward.y * Fx + tireRight.y * Fy) * dt,
          z: (tireForward.z * Fx + tireRight.z * Fy) * dt,
        },
        applyAt,
        true,
      );

      const driveT = pt.wheelDriveTorque[i];
      const brakeT = brakeOut.torques[i] * Math.sign(w.omega || vLong || 1);
      const tireReaction = -Fx * R;
      const netT = driveT - brakeT + tireReaction;
      const rr = surfaceRolling(w.surfaceId) * this.spec.rollingResistance * 0.25
        * Math.sign(w.omega || 1) * R * 0.15;
      w.omega += ((netT - rr) / this.spec.wheelInertia) * dt;
      if (Math.abs(w.omega) > 800) w.omega = Math.sign(w.omega) * 800;
      w.spin += w.omega * dt;

      const rough = (SURFACES[w.surfaceId] ?? SURFACES[0]).roughness;
      if (rough > 0.01 && speedMs > 2) {
        const n = (Math.random() - 0.5) * rough * w.load * 0.02;
        this.body.applyImpulseAtPoint(
          { x: up.x * n * dt, y: up.y * n * dt, z: up.z * n * dt },
          w.worldPos,
          true,
        );
      }
    }

    const drag = this.spec.dragCoef * speedMs * speedMs;
    if (speedMs > 0.1) {
      this.body.applyImpulse(
        { x: (-lv.x / speedMs) * drag * dt, y: 0, z: (-lv.z / speedMs) * drag * dt },
        true,
      );
    }

    if (this.stallImpulsePending) {
      this.stallImpulsePending = false;
      this.body.applyImpulse(
        { x: forward.x * -400, y: 80, z: forward.z * -400 },
        true,
      );
      this.body.applyTorqueImpulse({ x: 0, y: (Math.random() - 0.5) * 60, z: 0 }, true);
    }

    applyHydrodynamics(this.body, this.wheels, R, this.getWaterHeight, dt);
  }

  private applyAntiRoll(
    i0: number, i1: number,
    comps: number[],
    up: { x: number; y: number; z: number },
    q: { x: number; y: number; z: number; w: number },
    t: { x: number; y: number; z: number },
    dt: number,
  ) {
    const diff = (comps[i0] ?? 0) - (comps[i1] ?? 0);
    const f = diff * SUSPENSION.antiRoll;
    if (Math.abs(f) < 1) return;
    const a0 = quatTransformPoint(q, this.wheels[i0].attach, t);
    const a1 = quatTransformPoint(q, this.wheels[i1].attach, t);
    this.body.applyImpulseAtPoint(
      { x: up.x * -f * dt, y: up.y * -f * dt, z: up.z * -f * dt },
      a0, true,
    );
    this.body.applyImpulseAtPoint(
      { x: up.x * f * dt, y: up.y * f * dt, z: up.z * f * dt },
      a1, true,
    );
  }

  /** Flip / fall recovery. `heightAt` supplies ground Y at current XZ. */
  maybeRespawn(heightAt: (x: number, z: number) => number) {
    const t = this.body.translation();
    const q = this.body.rotation();
    const bodyUp = quatRotate(q, { x: 0, y: 1, z: 0 });
    if (bodyUp.y < 0.15 || t.y < -50) {
      const y = heightAt(t.x, t.z) + this.spec.halfExtents.y + this.spec.wheelRadius + 0.35;
      this.body.setTranslation({ x: t.x, y, z: t.z }, true);
      const yaw = Math.atan2(
        2 * (q.w * q.y + q.x * q.z),
        1 - 2 * (q.y * q.y + q.z * q.z),
      );
      const half = yaw * 0.5;
      this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.syncPose(true);
    }
  }

  snapshot(): VehicleSnapshot {
    const lv = this.body.linvel();
    const st = this.powertrain.engine.state;
    return {
      position: { ...this.currPos },
      rotation: { ...this.currRot },
      linearVel: { x: lv.x, y: lv.y, z: lv.z },
      speedMs: Math.hypot(lv.x, lv.z),
      wheels: this.getWheelVisuals(),
      rpm: this.powertrain.engine.rpm,
      gear: this.powertrain.gear,
      gearLabel: this.powertrain.gearLabel,
      engineState: st,
      fuelCut: this.powertrain.engine.fuelCut,
      engineLoad: this.powertrain.engine.load,
      clutchSlip: this.lastClutchSlip,
      clutchLocked: this.lastClutchLocked,
      handbrake: this.lastHandbrake,
      brakeTemp: this.brakes.temperature,
      steerAngle: this.steerAngle,
      stalled: st === 'stalled' || st === 'off',
      coldStart: this.powertrain.engine.coldStart,
    };
  }
}

function axisAngleQuat(axis: { x: number; y: number; z: number }, angle: number) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  return {
    x: (axis.x / len) * s,
    y: (axis.y / len) * s,
    z: (axis.z / len) * s,
    w: Math.cos(half),
  };
}

function slerpQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
  t: number,
) {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) {
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const inv = 1 / Math.hypot(x, y, z, w);
    return { x: x * inv, y: y * inv, z: z * inv, w: w * inv };
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const s0 = Math.sin(theta0 - theta) / Math.sin(theta0);
  const s1 = Math.sin(theta) / Math.sin(theta0);
  return {
    x: a.x * s0 + bx * s1,
    y: a.y * s0 + by * s1,
    z: a.z * s0 + bz * s1,
    w: a.w * s0 + bw * s1,
  };
}
