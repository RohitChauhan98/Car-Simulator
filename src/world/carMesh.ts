import * as THREE from 'three';
import type { WheelVisual } from '../physics/vehicle';
import { CHASSIS, SUSPENSION } from '../config';

/**
 * Hatchback from primitives. Driven by interpolated chassis pose + wheel visuals.
 *
 *   const mesh = new CarMesh();
 *   scene.add(mesh.root);
 *   // each frame:
 *   const { position, rotation } = vehicle.getInterpolated(alpha);
 *   mesh.update(position, rotation, vehicle.getWheelVisuals(), brake, vehicle.getSteerAngle());
 */
export class CarMesh {
  root = new THREE.Group();
  private wheelMeshes: THREE.Group[] = [];
  private brakeLights: THREE.Mesh[] = [];
  private invQuat = new THREE.Quaternion();
  private local = new THREE.Vector3();
  cockpit: THREE.Group;
  steeringWheel: THREE.Mesh;
  dash: THREE.Mesh;

  constructor(scene?: THREE.Scene) {
    const he = CHASSIS.halfExtents;
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xc45c2a,
      metalness: 0.35,
      roughness: 0.45,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.4, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x88aacc, metalness: 0.9, roughness: 0.15, transparent: true, opacity: 0.45,
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(he.x * 2, he.y * 1.3, he.z * 2), bodyMat);
    body.position.y = 0.1;
    body.castShadow = true;
    this.root.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(he.x * 1.7, he.y * 1.1, he.z * 1.1), bodyMat);
    cabin.position.set(0, he.y * 1.05, 0.15);
    cabin.castShadow = true;
    this.root.add(cabin);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(he.x * 1.5, he.y * 0.7, 0.08), glass);
    windshield.position.set(0, he.y * 1.05, -he.z * 0.55);
    windshield.rotation.x = -0.35;
    this.root.add(windshield);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(he.x * 1.85, 0.08, he.z * 0.7), bodyMat);
    hood.position.set(0, he.y * 0.55, -he.z * 0.65);
    this.root.add(hood);

    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(he.x * 1.95, 0.28, 0.3), dark);
    bumperF.position.set(0, -0.15, -he.z - 0.05);
    this.root.add(bumperF);
    const bumperR = bumperF.clone();
    bumperR.position.z = he.z + 0.05;
    this.root.add(bumperR);

    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x330000, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.5,
    });
    for (const sx of [-0.55, 0.55]) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 0.06), brakeMat.clone());
      bl.position.set(sx, 0.25, he.z + 0.12);
      this.root.add(bl);
      this.brakeLights.push(bl);
    }

    const tireMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.7, roughness: 0.35 });
    const R = SUSPENSION.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.22, 16), tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.55, R * 0.55, 0.24, 12), rimMat);
      rim.rotation.z = Math.PI / 2;
      g.add(tire, rim);
      this.root.add(g);
      this.wheelMeshes.push(g);
    }

    this.cockpit = new THREE.Group();
    this.dash = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.25, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.8 }),
    );
    this.dash.position.set(0, 0.35, -0.55);
    this.cockpit.add(this.dash);

    this.steeringWheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.18, 0.025, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x111111 }),
    );
    this.steeringWheel.position.set(-0.32, 0.48, -0.35);
    this.steeringWheel.rotation.x = Math.PI / 2.2;
    this.cockpit.add(this.steeringWheel);

    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.5, 0.45),
      new THREE.MeshStandardMaterial({ color: 0x3a3030 }),
    );
    seat.position.set(-0.32, 0.15, 0.05);
    this.cockpit.add(seat);
    this.root.add(this.cockpit);

    if (scene) scene.add(this.root);
  }

  update(
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    wheels: WheelVisual[],
    brakePedal: number,
    steerAngle: number,
  ) {
    this.root.position.set(position.x, position.y, position.z);
    this.root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.invQuat.copy(this.root.quaternion).invert();

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const m = this.wheelMeshes[i];
      if (!w) continue;
      this.local
        .set(
          w.position.x - position.x,
          w.position.y - position.y,
          w.position.z - position.z,
        )
        .applyQuaternion(this.invQuat);
      m.position.copy(this.local);
      m.rotation.set(0, w.steer, 0);
      m.rotateX(w.spin);
    }

    for (const bl of this.brakeLights) {
      const mat = bl.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(brakePedal > 0.1 ? 0xff1100 : 0x000000);
      mat.color.setHex(brakePedal > 0.1 ? 0xff2200 : 0x330000);
    }

    this.steeringWheel.rotation.z = -steerAngle * 2.5;
  }
}
