import * as THREE from 'three';
import RAPIER, { type World, type RigidBody } from '@dimforge/rapier3d-compat';
import { CAMERA, ENGINE } from '../config';
import type { OcclusionHash } from '../world/occlusion';

export type CameraMode = 'chase' | 'hood' | 'cinematic';

export type ChassisTransform = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  rpm?: number;
  engineRunning?: boolean;
  linearVel?: { x: number; y: number; z: number };
};

const MODE_ORDER: CameraMode[] = ['chase', 'hood', 'cinematic'];

/**
 * Orbit chase / hood / cinematic cameras.
 * Chase yaw is heading-relative so mouse look inspects the vehicle from any side
 * while the camera still follows the car.
 */
export class CameraController {
  mode: CameraMode = 'chase';

  private shake = 0;
  private idlePhase = 0;
  private cineAngle = 0;
  private chasePos = new THREE.Vector3();
  private lookSmoothed = new THREE.Vector3();
  private initialized = false;
  private hoodOffset = { ...CAMERA.hoodOffset };

  private userYaw = 0;
  private userPitch = Math.asin(
    Math.min(0.92, CAMERA.chaseHeight / Math.max(1, CAMERA.chaseDistance)),
  );
  private distance = CAMERA.chaseDistance;
  private prevVel = new THREE.Vector3();
  private accelSmoothed = new THREE.Vector3();

  private occluders: OcclusionHash | null = null;
  private heightAt: ((x: number, z: number) => number) | null = null;

  private readonly _pos = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _forward = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _ideal = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _tmp = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _euler = new THREE.Euler();
  private readonly _vel = new THREE.Vector3();

  constructor(public camera: THREE.PerspectiveCamera) {
    this.camera.fov = CAMERA.fov;
    this.camera.near = 0.1;
    this.camera.far = 2800;
    this.camera.updateProjectionMatrix();
  }

  cycle(): CameraMode {
    this.mode = MODE_ORDER[(MODE_ORDER.indexOf(this.mode) + 1) % MODE_ORDER.length];
    this.initialized = false;
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.initialized = false;
    }
  }

  setHoodOffset(offset: { x: number; y: number; z: number }) {
    this.hoodOffset = offset;
  }

  setOccluders(hash: OcclusionHash | null) {
    this.occluders = hash;
  }

  setHeightAt(fn: ((x: number, z: number) => number) | null) {
    this.heightAt = fn;
  }

  /** Mouse / wheel look. Call once per frame before update. */
  applyLook(dx: number, dy: number, zoom: number) {
    const inv = CAMERA.invertY ? -1 : 1;
    this.userYaw -= dx * CAMERA.mouseSensitivity;
    this.userPitch += dy * CAMERA.mouseSensitivity * inv;
    this.userPitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, this.userPitch));
    this.distance = Math.max(
      CAMERA.distanceMin,
      Math.min(CAMERA.distanceMax, this.distance + zoom * CAMERA.zoomSensitivity),
    );
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  update(
    dt: number,
    chassis: ChassisTransform,
    rapierWorld: World | null,
    excludeBody: RigidBody | null,
  ): void {
    const safeDt = Math.max(0, Math.min(dt, 0.1));

    this._pos.set(chassis.position.x, chassis.position.y, chassis.position.z);
    this._quat.set(chassis.rotation.x, chassis.rotation.y, chassis.rotation.z, chassis.rotation.w);
    this._forward.set(0, 0, -1).applyQuaternion(this._quat);
    this._up.set(0, 1, 0).applyQuaternion(this._quat);
    this._right.set(1, 0, 0).applyQuaternion(this._quat);

    this.shake = Math.max(0, this.shake - safeDt * 2.5);
    this.idlePhase += safeDt * 9;

    const rpm = chassis.rpm ?? 0;
    const running = chassis.engineRunning ?? false;
    const idleVib =
      running && rpm > 0 && rpm < ENGINE.idleRPM + 300
        ? Math.sin(this.idlePhase) * 0.008 * (1 - Math.min(1, (rpm - 600) / 600))
        : 0;

    if (chassis.linearVel) {
      this._vel.set(chassis.linearVel.x, chassis.linearVel.y, chassis.linearVel.z);
      const invDt = 1 / Math.max(safeDt, 1 / 120);
      this.accelSmoothed.x += ((this._vel.x - this.prevVel.x) * invDt - this.accelSmoothed.x) * Math.min(1, safeDt * 8);
      this.accelSmoothed.y += ((this._vel.y - this.prevVel.y) * invDt - this.accelSmoothed.y) * Math.min(1, safeDt * 8);
      this.accelSmoothed.z += ((this._vel.z - this.prevVel.z) * invDt - this.accelSmoothed.z) * Math.min(1, safeDt * 8);
      this.prevVel.copy(this._vel);
    }

    if (this.mode === 'chase') {
      this.updateChase(safeDt, rapierWorld, excludeBody);
    } else if (this.mode === 'hood') {
      this.updateHood();
    } else {
      this.updateCinematic(safeDt);
    }

    if (this.shake > 0.01 || idleVib !== 0) {
      const s = this.shake * 0.09;
      this.camera.position.x += (Math.random() - 0.5) * s + idleVib;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.7 + idleVib * 0.5;
      this.camera.position.z += (Math.random() - 0.5) * s * 0.55;
    }
  }

  private updateChase(
    dt: number,
    rapierWorld: World | null,
    excludeBody: RigidBody | null,
  ): void {
    this._euler.setFromQuaternion(this._quat, 'YXZ');

    const heading = Math.atan2(-this._forward.x, -this._forward.z);
    const yaw = heading + this.userYaw;
    const pitch = this.userPitch;
    const dist = this.distance;
    const horiz = dist * Math.cos(pitch);
    const follow = CAMERA.chassisFollow;

    this._look.copy(this._pos);
    this._look.y += CAMERA.lookAtHeight;
    this._look.y += this._euler.x * follow * 1.6;
    this._look.addScaledVector(this._right, this._euler.z * follow * 0.9);
    this._look.addScaledVector(this._forward, CAMERA.lookAhead);

    const ar = CAMERA.accelResponse;
    this._look.x -= this.accelSmoothed.x * ar * 0.04;
    this._look.z -= this.accelSmoothed.z * ar * 0.04;
    this._look.y -= Math.max(-2.5, Math.min(2.5, this.accelSmoothed.y)) * ar * 0.03;

    this._ideal.set(
      this._look.x + Math.sin(yaw) * horiz,
      this._look.y + Math.sin(pitch) * dist,
      this._look.z + Math.cos(yaw) * horiz,
    );

    this.applyCollision(rapierWorld, excludeBody);

    if (this.heightAt) {
      const floor = this.heightAt(this._ideal.x, this._ideal.z) + 0.55;
      if (this._ideal.y < floor) this._ideal.y = floor;
    }

    if (!this.initialized) {
      this.chasePos.copy(this._ideal);
      this.lookSmoothed.copy(this._look);
      this.initialized = true;
    }

    const k = 1 - Math.exp(-CAMERA.chaseStiffness * dt);
    this.chasePos.lerp(this._ideal, k);
    this.lookSmoothed.lerp(this._look, 1 - Math.exp(-CAMERA.chaseStiffness * 1.35 * dt));
    this.camera.position.copy(this.chasePos);
    this.camera.lookAt(this.lookSmoothed);
  }

  private applyCollision(rapierWorld: World | null, excludeBody: RigidBody | null) {
    this._rayOrigin.copy(this._look);
    this._tmp.copy(this._ideal).sub(this._rayOrigin);
    const dist = this._tmp.length();
    if (dist < 0.05) return;
    this._tmp.multiplyScalar(1 / dist);

    let hitDist = dist;

    if (rapierWorld) {
      const ray = new RAPIER.Ray(
        { x: this._rayOrigin.x, y: this._rayOrigin.y, z: this._rayOrigin.z },
        { x: this._tmp.x, y: this._tmp.y, z: this._tmp.z },
      );
      const hit = rapierWorld.castRay(
        ray,
        dist,
        true,
        undefined,
        undefined,
        undefined,
        excludeBody ?? undefined,
      );
      if (hit !== null && hit.timeOfImpact < hitDist) {
        hitDist = hit.timeOfImpact;
      }
    }

    if (this.occluders) {
      const occ = this.occluders.cast(
        this._rayOrigin.x,
        this._rayOrigin.y,
        this._rayOrigin.z,
        this._tmp.x,
        this._tmp.y,
        this._tmp.z,
        dist,
      );
      if (occ !== null && occ < hitDist) hitDist = occ;
    }

    if (hitDist < dist) {
      const pull = Math.max(4.2, hitDist - CAMERA.collisionSkin);
      this._ideal.copy(this._rayOrigin).addScaledVector(this._tmp, pull);
    }
  }

  private updateHood(): void {
    const off = this.hoodOffset;
    this._tmp.set(off.x, off.y, off.z).applyQuaternion(this._quat).add(this._pos);
    this.camera.position.copy(this._tmp);

    this._look
      .copy(this._pos)
      .addScaledVector(this._forward, 14)
      .addScaledVector(this._up, 0.15);
    this.camera.lookAt(this._look);
    this.initialized = false;
  }

  private updateCinematic(dt: number): void {
    this.cineAngle += dt * 0.15;
    const r = CAMERA.cinematicRadius;
    this.camera.position.set(
      this._pos.x + Math.cos(this.cineAngle) * r,
      this._pos.y + 8 + Math.sin(this.cineAngle * 0.5) * 3,
      this._pos.z + Math.sin(this.cineAngle) * r,
    );
    this.camera.lookAt(this._pos);
    this.initialized = false;
  }
}
