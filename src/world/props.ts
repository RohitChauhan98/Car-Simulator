import * as THREE from 'three';
import RAPIER, { World as RapierWorld, RigidBody } from '@dimforge/rapier3d-compat';
import { WORLD } from '../config';
import type { RoadNetwork } from './road';

function rand(seed: { n: number }) {
  seed.n = (seed.n * 16807) % 2147483647;
  return (seed.n - 1) / 2147483646;
}

export type PropsSystem = {
  group: THREE.Group;
  update: (dt: number, carPos: THREE.Vector3) => void;
  dispose: () => void;
};

/**
 * Instanced trees, rocks, pebbles, guardrails, prayer flags, stone huts.
 * Selective rock colliders; pebble dynamics synced to instances.
 */
export function createProps(
  scene: THREE.Scene,
  physics: RapierWorld,
  road: RoadNetwork,
  heightAt: (x: number, z: number) => number,
  surfaceAt: (x: number, z: number) => number,
): PropsSystem {
  const group = new THREE.Group();
  scene.add(group);
  const seed = { n: 42 };
  const half = WORLD.size * 0.5;

  // ---- Trees (deodar-ish cones) ----
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.25, 2.2, 5);
  const canopyGeo = new THREE.ConeGeometry(1.4, 4.5, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3422, roughness: 0.9 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x1f4a28, roughness: 0.85 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, WORLD.treeCount);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, WORLD.treeCount);
  trunks.castShadow = canopies.castShadow = true;
  const dummy = new THREE.Object3D();
  let treeI = 0;
  while (treeI < WORLD.treeCount) {
    const x = (rand(seed) - 0.5) * WORLD.size * 0.92;
    const z = (rand(seed) - 0.5) * WORLD.size * 0.92;
    const infl = road.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 6) continue;
    if (Math.abs(z - WORLD.riverZ) < WORLD.riverHalfWidth + 4) continue;
    const y = heightAt(x, z);
    if (y < 25 || y > 175) continue;
    if (surfaceAt(x, z) === 0) continue;
    const s = 0.7 + rand(seed) * 1.1;
    dummy.position.set(x, y + 1.1 * s, z);
    dummy.scale.set(s, s, s);
    dummy.rotation.set(0, rand(seed) * Math.PI * 2, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(treeI, dummy.matrix);
    dummy.position.y = y + 3.2 * s;
    dummy.updateMatrix();
    canopies.setMatrixAt(treeI, dummy.matrix);
    treeI++;
  }
  trunks.count = canopies.count = treeI;
  group.add(trunks, canopies);

  // ---- Rocks ----
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6e675e, roughness: 0.95, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, WORLD.rockCount);
  rocks.castShadow = true;
  const rockPositions: { x: number; y: number; z: number; s: number }[] = [];
  let rockI = 0;
  while (rockI < WORLD.rockCount) {
    const x = (rand(seed) - 0.5) * WORLD.size * 0.9;
    const z = (rand(seed) - 0.5) * WORLD.size * 0.9;
    const infl = road.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 2) continue;
    const y = heightAt(x, z);
    const s = 0.4 + rand(seed) * 2.2;
    dummy.position.set(x, y + s * 0.35, z);
    dummy.scale.set(s * (0.7 + rand(seed)), s, s * (0.7 + rand(seed)));
    dummy.rotation.set(rand(seed), rand(seed) * 6, rand(seed));
    dummy.updateMatrix();
    rocks.setMatrixAt(rockI, dummy.matrix);
    rockPositions.push({ x, y, z, s });
    rockI++;
  }
  rocks.count = rockI;
  group.add(rocks);

  // Selective rock colliders (largest / near road)
  const colliderCandidates = [...rockPositions]
    .sort((a, b) => b.s - a.s)
    .slice(0, WORLD.colliderRockCount);
  for (const r of colliderCandidates) {
    const body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(r.x, r.y + r.s * 0.35, r.z),
    );
    physics.createCollider(
      RAPIER.ColliderDesc.ball(r.s * 0.55).setFriction(0.9),
      body,
    );
  }

  // ---- Pebbles (dynamic, synced) ----
  const pebbleGeo = new THREE.DodecahedronGeometry(0.18, 0);
  const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x8a8074, flatShading: true });
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, WORLD.pebbleCount);
  group.add(pebbles);
  const pebbleBodies: RigidBody[] = [];
  const mainSamples = road.sampleMain(80);
  for (let i = 0; i < WORLD.pebbleCount; i++) {
    const s = mainSamples[10 + (i % 60)];
    const side = (i % 2 === 0 ? 1 : -1) * (s.width * 0.35 + rand(seed) * 2);
    const x = s.position.x + s.normal.x * side;
    const z = s.position.z + s.normal.z * side;
    const y = heightAt(x, z) + 0.3;
    const body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setAdditionalMassProperties(4, { x: 0, y: 0, z: 0 }, { x: 0.05, y: 0.05, z: 0.05 }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    physics.createCollider(RAPIER.ColliderDesc.ball(0.16).setFriction(0.8).setDensity(0), body);
    pebbleBodies.push(body);
  }

  // ---- Guardrails along steep sections ----
  const postGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12);
  const railGeo = new THREE.BoxGeometry(2.2, 0.08, 0.05);
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
  const posts = new THREE.InstancedMesh(postGeo, metalMat, 400);
  const rails = new THREE.InstancedMesh(railGeo, metalMat, 400);
  let gi = 0;
  for (const s of road.sampleMain(120)) {
    if (s.position.y < 70) continue;
    for (const side of [-1, 1]) {
      if (gi >= 400) break;
      const x = s.position.x + s.normal.x * side * (s.width * 0.5 + 0.6);
      const z = s.position.z + s.normal.z * side * (s.width * 0.5 + 0.6);
      const y = heightAt(x, z);
      dummy.position.set(x, y + 0.45, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, Math.atan2(s.tangent.x, s.tangent.z), 0);
      dummy.updateMatrix();
      posts.setMatrixAt(gi, dummy.matrix);
      dummy.position.y = y + 0.7;
      dummy.updateMatrix();
      rails.setMatrixAt(gi, dummy.matrix);
      gi++;
    }
  }
  posts.count = rails.count = gi;
  group.add(posts, rails);

  // ---- Prayer flags (shader wind) ----
  const flagGeo = new THREE.PlaneGeometry(8, 0.55, 8, 1);
  const flagMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        float along = uv.x;
        p.z += sin(uTime * 2.5 + along * 6.0 + position.x) * 0.25 * along;
        p.y += sin(uTime * 3.0 + along * 4.0) * 0.08 * along;
        vA = 0.55 + 0.45 * (1.0 - along);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vA;
      void main() {
        gl_FragColor = vec4(uColor, vA);
      }
    `,
  });
  const flagColors = [0xc43c3c, 0xd4a017, 0x2d6a4f, 0x3d5a80, 0xffffff];
  const flagMeshes: THREE.Mesh[] = [];
  const highSamples = road.sampleMain(40).filter((s) => s.position.y > 100);
  for (let i = 0; i < Math.min(12, highSamples.length); i++) {
    const s = highSamples[i];
    const mat = flagMat.clone();
    mat.uniforms.uColor.value = new THREE.Color(flagColors[i % flagColors.length]);
    const mesh = new THREE.Mesh(flagGeo, mat);
    const x = s.position.x + s.normal.x * (s.width * 0.5 + 1.5);
    const z = s.position.z + s.normal.z * (s.width * 0.5 + 1.5);
    mesh.position.set(x, heightAt(x, z) + 2.5, z);
    mesh.lookAt(s.position.x, mesh.position.y, s.position.z);
    group.add(mesh);
    flagMeshes.push(mesh);
  }

  // ---- Stone huts ----
  const hutMat = new THREE.MeshStandardMaterial({ color: 0x7a7368, roughness: 0.95, flatShading: true });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 1, flatShading: true });
  for (let i = 0; i < 5; i++) {
    const s = mainSamples[15 + i * 12];
    const side = i % 2 === 0 ? 1 : -1;
    const x = s.position.x + s.normal.x * side * 14;
    const z = s.position.z + s.normal.z * side * 14;
    const y = heightAt(x, z);
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2.2, 3.5), hutMat);
    base.position.set(x, y + 1.1, z);
    base.castShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.6, 4), roofMat);
    roof.position.set(x, y + 2.9, z);
    roof.rotation.y = Math.PI / 4;
    group.add(base, roof);
    const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + 1.1, z));
    physics.createCollider(RAPIER.ColliderDesc.cuboid(2.25, 1.1, 1.75), body);
  }

  let time = 0;
  const pebbleDummy = new THREE.Object3D();

  return {
    group,
    update(dt, carPos) {
      time += dt;
      for (const m of flagMeshes) {
        (m.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
      }
      // Sync pebbles; wake near the car for dynamics
      for (let i = 0; i < pebbleBodies.length; i++) {
        const b = pebbleBodies[i];
        const p = b.translation();
        const r = b.rotation();
        const dist = Math.hypot(p.x - carPos.x, p.z - carPos.z);
        if (dist < 40) b.wakeUp();
        else if (dist > 80) b.sleep();
        pebbleDummy.position.set(p.x, p.y, p.z);
        pebbleDummy.quaternion.set(r.x, r.y, r.z, r.w);
        pebbleDummy.scale.set(1, 1, 1);
        pebbleDummy.updateMatrix();
        pebbles.setMatrixAt(i, pebbleDummy.matrix);
      }
      pebbles.instanceMatrix.needsUpdate = true;
      void half;
    },
    dispose() {
      group.removeFromParent();
      trunkGeo.dispose();
      canopyGeo.dispose();
      trunkMat.dispose();
      canopyMat.dispose();
      rockGeo.dispose();
      rockMat.dispose();
      pebbleGeo.dispose();
      pebbleMat.dispose();
      postGeo.dispose();
      railGeo.dispose();
      metalMat.dispose();
      flagGeo.dispose();
      flagMat.dispose();
      hutMat.dispose();
      roofMat.dispose();
    },
  };
}
