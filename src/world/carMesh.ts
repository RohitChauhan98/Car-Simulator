import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { WheelVisual } from '../physics/vehicle';
import type { VehicleSpec } from '../config';
import { createTireVisual, type TireVisual } from './tires';

const fbxLoader = new FBXLoader();
fbxLoader.setResourcePath('/vehicles/');
const texLoader = new THREE.TextureLoader();
const fbxCache = new Map<string, Promise<THREE.Group>>();
const texCache = new Map<string, Promise<THREE.Texture>>();

function loadFbx(url: string): Promise<THREE.Group> {
  let pending = fbxCache.get(url);
  if (!pending) {
    pending = fbxLoader.loadAsync(url);
    fbxCache.set(url, pending);
  }
  return pending;
}

function loadTexture(url: string): Promise<THREE.Texture> {
  let pending = texCache.get(url);
  if (!pending) {
    pending = texLoader.loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    });
    texCache.set(url, pending);
  }
  return pending;
}

function isWheelName(name: string): boolean {
  const n = name.toLowerCase();
  if (/steering/.test(n)) return false;
  return /(tire|wheel|rim)/.test(n);
}

/** Match skinned wheel bones: Tire_F_L / Wheel_R_R etc. */
function classifyWheelBone(name: string): number | null {
  const n = name.toLowerCase();
  if (/steering|root/.test(n)) return null;
  if (!/(tire|wheel)/.test(n)) return null;
  if (/_f_l/.test(n)) return 0;
  if (/_f_r/.test(n)) return 1;
  if (/_r_l/.test(n)) return 2;
  if (/_r_r/.test(n)) return 3;
  return null;
}

function partKind(name: string): 'glass' | 'chrome' | 'light' | 'wheel' | 'body' {
  const n = name.toLowerCase();
  if (isWheelName(n)) return 'wheel';
  if (/(window|glass|windshield|windscreen|windscreen)/.test(n)) return 'glass';
  if (/(chrome|bumper|grill|grille|exhaust|steel|metal)/.test(n)) return 'chrome';
  if (/(headlight|taillight|lamp|light)/.test(n)) return 'light';
  return 'body';
}

function applyMaterials(root: THREE.Object3D, albedo: THREE.Texture, metal?: THREE.Texture) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const kind = partKind(mesh.name);
    if (kind === 'wheel') {
      mesh.visible = false;
      return;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => {
      const mat = (m as THREE.MeshStandardMaterial).clone();
      if (!mat.isMeshStandardMaterial) return mat;
      if (kind === 'glass') {
        mat.map = null;
        mat.color.set(0x88aacc);
        mat.transparent = true;
        mat.opacity = 0.38;
        mat.roughness = 0.06;
        mat.metalness = 0.05;
        mat.envMapIntensity = 1.6;
        mat.side = THREE.DoubleSide;
      } else if (kind === 'chrome') {
        mat.map = metal ?? null;
        mat.color.set(0xc8c8d0);
        mat.metalness = 0.92;
        mat.roughness = 0.22;
        mat.envMapIntensity = 1.4;
      } else if (kind === 'light') {
        mat.map = null;
        mat.color.set(0xf2f0e4);
        mat.emissive.set(0x222018);
        mat.roughness = 0.35;
        mat.metalness = 0.2;
      } else {
        mat.map = albedo;
        if (metal) {
          mat.metalnessMap = metal;
          mat.metalness = 0.45;
          mat.roughness = 0.48;
        } else {
          mat.metalness = 0.32;
          mat.roughness = 0.52;
        }
        mat.envMapIntensity = 1.1;
      }
      mat.needsUpdate = true;
      return mat;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

type WheelBone = {
  bone: THREE.Bone;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
};

/**
 * Off-road FBX body (skinned) plus dedicated physics-posed tires.
 */
export class CarMesh {
  root = new THREE.Group();
  private wheelBones: (WheelBone | null)[] = [null, null, null, null];
  private tireVisuals: TireVisual[] = [];
  private brakeLights: THREE.Mesh[] = [];
  private steerBone: THREE.Bone | null = null;
  private steerRest = new THREE.Quaternion();
  private steerQ = new THREE.Quaternion();
  private invQuat = new THREE.Quaternion();
  private localPos = new THREE.Vector3();
  cockpit: THREE.Group;
  steeringWheel: THREE.Mesh;
  dash: THREE.Mesh;
  spec: VehicleSpec;

  private constructor(spec: VehicleSpec) {
    this.spec = spec;
    this.cockpit = new THREE.Group();
    this.dash = new THREE.Mesh();
    this.steeringWheel = new THREE.Mesh();
  }

  static async create(spec: VehicleSpec, scene: THREE.Scene): Promise<CarMesh> {
    const mesh = new CarMesh(spec);
    await mesh.build();
    scene.add(mesh.root);
    return mesh;
  }

  private async build() {
    const spec = this.spec;
    const [fbx, albedo, metal] = await Promise.all([
      loadFbx(spec.bodyUrl),
      loadTexture(spec.albedoUrl),
      loadTexture('/vehicles/Textures/Metalic_Texture.png'),
    ]);

    const body = cloneSkinned(fbx) as THREE.Group;
    applyMaterials(body, albedo, metal);
    body.scale.setScalar(spec.scale);
    body.rotation.y = spec.rootYaw;
    body.position.set(spec.bodyOffset.x, spec.bodyOffset.y, spec.bodyOffset.z);
    body.updateMatrixWorld(true);
    this.root.add(body);

    body.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        const idx = classifyWheelBone(obj.name);
        if (idx !== null && !this.wheelBones[idx]) {
          const bone = obj as THREE.Bone;
          this.wheelBones[idx] = {
            bone,
            restPos: bone.position.clone(),
            restQuat: bone.quaternion.clone(),
          };
          bone.scale.setScalar(0.001);
        }
        if (/steering_wheel/i.test(obj.name) && !this.steerBone) {
          this.steerBone = obj as THREE.Bone;
          this.steerRest.copy(this.steerBone.quaternion);
        }
      }
      if (isWheelName(obj.name)) obj.visible = false;
    });

    for (let i = 0; i < 4; i++) {
      const tv = createTireVisual(spec.wheelRadius, 0.32);
      tv.group.userData.owned = true;
      this.root.add(tv.group);
      this.tireVisuals.push(tv);
    }

    const he = spec.halfExtents;
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x330000, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.5,
    });
    for (const sx of [-0.55, 0.55]) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.05), brakeMat.clone());
      bl.position.set(sx * he.x, 0.15, he.z + 0.02);
      bl.userData.owned = true;
      this.root.add(bl);
      this.brakeLights.push(bl);
    }

    this.cockpit = new THREE.Group();
    this.dash = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 0.22, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.8 }),
    );
    this.dash.position.set(0, spec.hoodOffset.y - 0.28, spec.hoodOffset.z - 0.35);
    this.dash.userData.owned = true;
    this.cockpit.add(this.dash);

    this.steeringWheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.022, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x111111 }),
    );
    this.steeringWheel.position.set(
      spec.hoodOffset.x,
      spec.hoodOffset.y - 0.12,
      spec.hoodOffset.z - 0.18,
    );
    this.steeringWheel.rotation.x = Math.PI / 2.2;
    this.steeringWheel.userData.owned = true;
    this.cockpit.add(this.steeringWheel);

    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.48, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x3a3030 }),
    );
    seat.position.set(spec.hoodOffset.x, spec.hoodOffset.y - 0.42, spec.hoodOffset.z + 0.22);
    seat.userData.owned = true;
    this.cockpit.add(seat);
    this.cockpit.visible = false;
    this.root.add(this.cockpit);
  }

  setInteriorVisible(visible: boolean) {
    this.cockpit.visible = visible;
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
      const tv = this.tireVisuals[i];
      if (!w || !tv) continue;
      this.localPos.set(w.position.x, w.position.y, w.position.z)
        .sub(this.root.position)
        .applyQuaternion(this.invQuat);
      tv.group.position.copy(this.localPos);
      tv.group.rotation.order = 'YXZ';
      tv.group.rotation.set(w.spin, w.steer, 0);
    }

    if (this.steerBone) {
      this.steerQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -steerAngle * 2.5);
      this.steerBone.quaternion.copy(this.steerRest).multiply(this.steerQ);
    }

    for (const bl of this.brakeLights) {
      const mat = bl.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(brakePedal > 0.1 ? 0xff1100 : 0x000000);
      mat.color.setHex(brakePedal > 0.1 ? 0xff2200 : 0x330000);
    }

    this.steeringWheel.rotation.z = -steerAngle * 2.5;
  }

  dispose() {
    this.root.removeFromParent();
    for (const tv of this.tireVisuals) tv.dispose();
    this.tireVisuals = [];
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.userData.owned) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    });
  }
}
