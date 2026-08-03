import * as THREE from 'three';
import RAPIER, { type World, type RigidBody } from '@dimforge/rapier3d-compat';
import { CAMERA, ENGINE } from '../config';

export type CameraMode = 'chase' | 'hood' | 'cinematic';

export type ChassisTransform = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** Optional engine feedback for idle vibration */
  rpm?: number;
  engineRunning?: boolean;
};

const MODE_ORDER: CameraMode[] = ['chase', 'hood', 'cinematic'];

/**
 * Chase / hood / cinematic cameras with spring follow, Rapier collision
 * pullback, shake, and idle vibration.
 *
 * update(dt, chassisTransform, rapierWorld, excludeBody)
 */
export class CameraController {
  mode: CameraMode = 'chase';

  private shake = 0;
  private idlePhase = 0;
  private cineAngle = 0;
  private chasePos = new THREE.Vector3();
  private initialized = false;

  private readonly _pos = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _forward = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _ideal = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _tmp = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();

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

  /** Add camera shake impulse (stall, impact, etc.). */
  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /**
   * @param dt seconds
   * @param chassis chassis world transform (+ optional rpm / engineRunning)
   * @param rapierWorld for chase collision pullback
   * @param excludeBody vehicle chassis body to ignore in pullback rays
   */
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

    this.shake = Math.max(0, this.shake - safeDt * 2.5);
    this.idlePhase += safeDt * 9;

    const rpm = chassis.rpm ?? 0;
    const running = chassis.engineRunning ?? false;
    const idleVib =
      running && rpm > 0 && rpm < ENGINE.idleRPM + 300
        ? Math.sin(this.idlePhase) * 0.008 * (1 - Math.min(1, (rpm - 600) / 600))
        : 0;

    if (this.mode === 'chase') {
      this.updateChase(safeDt, rapierWorld, excludeBody);
    } else if (this.mode === 'hood') {
      this.updateHood();
    } else {
      this.updateCinematic(safeDt);
    }

    if (this.shake > 0.01 || idleVib !== 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.15 + idleVib;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.1 + idleVib * 0.5;
      this.camera.position.z += (Math.random() - 0.5) * this.shake * 0.08;
    }
  }

  private updateChase(
    dt: number,
    rapierWorld: World | null,
    excludeBody: RigidBody | null,
  ): void {
    this._ideal
      .copy(this._pos)
      .addScaledVector(this._forward, -CAMERA.chaseDistance)
      .addScaledVector(this._up, CAMERA.chaseHeight);

    // Collision pullback: ray from above chassis toward ideal camera
    if (rapierWorld) {
      this._rayOrigin.copy(this._pos).addScaledVector(this._up, 0.85);
      this._tmp.copy(this._ideal).sub(this._rayOrigin);
      const dist = this._tmp.length();
      if (dist > 0.01) {
        this._tmp.multiplyScalar(1 / dist);
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
        if (hit !== null && hit.timeOfImpact < dist) {
          const pull = Math.max(1.4, hit.timeOfImpact - 0.35);
          this._ideal
            .copy(this._rayOrigin)
            .addScaledVector(this._tmp, pull);
        }
      }
    }

    if (!this.initialized) {
      this.chasePos.copy(this._ideal);
      this.initialized = true;
    }

    const k = 1 - Math.exp(-CAMERA.chaseStiffness * dt);
    this.chasePos.lerp(this._ideal, k);
    this.camera.position.copy(this.chasePos);

    this._look
      .copy(this._pos)
      .addScaledVector(this._forward, CAMERA.lookAhead)
      .addScaledVector(this._up, 0.55);
    this.camera.lookAt(this._look);
  }

  private updateHood(): void {
    const off = CAMERA.hoodOffset;
    this._tmp.set(off.x, off.y, off.z).applyQuaternion(this._quat).add(this._pos);
    this.camera.position.copy(this._tmp);

    this._look
      .copy(this._pos)
      .addScaledVector(this._forward, 14)
      .addScaledVector(this._up, 0.15);
    this.camera.lookAt(this._look);
    this.initialized = false;
  }

  /** Orbiting tripod around the car. */
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
