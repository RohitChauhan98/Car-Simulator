import * as THREE from 'three';
import RAPIER, { World as RapierWorld } from '@dimforge/rapier3d-compat';
import { WORLD } from '../config';
import type { TrailNetwork } from './trail';
import type { OcclusionHash } from './occlusion';
import type { EnvTextures } from './assets';
import { tagCollider } from '../physics/materials';

function rand(seed: { n: number }) {
  seed.n = (seed.n * 16807) % 2147483647;
  return (seed.n - 1) / 2147483646;
}

function jitterGeo(geo: THREE.BufferGeometry, amount: number, seed: { n: number }) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rand(seed) - 0.5) * amount,
      pos.getY(i) + (rand(seed) - 0.5) * amount * 0.6,
      pos.getZ(i) + (rand(seed) - 0.5) * amount,
    );
  }
  geo.computeVertexNormals();
}

export type ObstacleSystem = {
  group: THREE.Group;
  dispose: () => void;
};

/**
 * Embedded rocks + fallen logs with Rapier colliders. Wheels already raycast
 * the world, so one wheel on a rock tilts the chassis for real.
 */
export function createObstacles(
  scene: THREE.Scene,
  physics: RapierWorld,
  trail: TrailNetwork,
  heightAt: (x: number, z: number) => number,
  occluders: OcclusionHash,
  textures: EnvTextures,
  seedN = 91,
): ObstacleSystem {
  const group = new THREE.Group();
  scene.add(group);
  const seed = { n: seedN };
  const dummy = new THREE.Object3D();
  const samples = trail.sample(220);

  const rockGeos = [
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.DodecahedronGeometry(1, 0),
  ];
  for (const g of rockGeos) jitterGeo(g, 0.28, seed);

  const rockMat = new THREE.MeshStandardMaterial({
    map: textures.rock,
    normalMap: textures.rockN,
    color: 0xc8c6c0,
    roughness: 0.78,
    metalness: 0.06,
    envMapIntensity: 0.45,
  });
  const rockMatB = rockMat.clone();
  rockMatB.color = new THREE.Color(0xb0b4b8);
  const rockMatC = rockMat.clone();
  rockMatC.color = new THREE.Color(0xd0cec6);

  const mats = [rockMat, rockMatB, rockMatC];
  const rockMeshes = rockGeos.map((g, i) => {
    const mesh = new THREE.InstancedMesh(g, mats[i % mats.length], WORLD.rockCount);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
    return mesh;
  });

  const rockPositions: { x: number; y: number; z: number; s: number; sx: number; sy: number; sz: number }[] = [];
  const color = new THREE.Color();
  let placed = 0;

  const placeRock = (x: number, z: number, s: number) => {
    if (placed >= WORLD.rockCount) return;
    const y = heightAt(x, z);
    const embed = s * 0.38;
    const sx = s * (0.85 + rand(seed) * 0.35);
    const sy = s * (0.5 + rand(seed) * 0.22);
    const sz = s * (0.8 + rand(seed) * 0.4);
    dummy.position.set(x, y + s * 0.32 - embed, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(rand(seed) * 0.7, rand(seed) * 6.28, rand(seed) * 0.5);
    dummy.updateMatrix();
    const mesh = rockMeshes[placed % rockMeshes.length];
    const idx = mesh.count;
    mesh.setMatrixAt(idx, dummy.matrix);
    color.setHSL(0.08, 0.04 + rand(seed) * 0.05, 0.52 + rand(seed) * 0.16);
    mesh.setColorAt(idx, color);
    mesh.count++;
    rockPositions.push({ x, y: dummy.position.y, z, s, sx, sy, sz });
    placed++;
  };

  // On-path small/medium stones + roadside boulders. Opening stretch is already mixed.
  for (const s of samples) {
    if (placed >= WORLD.rockCount * 0.72) break;
    const opening = s.t < 0.15;
    const rocky = s.kind === 'rocks' || s.kind === 'descent' || s.kind === 'climb';
    const halfW = s.width * 0.5;
    const spawnClear = s.t < 0.055;

    const onPathN = spawnClear
      ? (rand(seed) > 0.55 ? 1 : 0)
      : opening || rocky ? 2 + ((rand(seed) * 2) | 0) : rand(seed) > 0.55 ? 1 : 0;
    for (let k = 0; k < onPathN; k++) {
      const side = (rand(seed) - 0.5) * s.width * 0.62;
      const along = (rand(seed) - 0.5) * 2.4;
      placeRock(
        s.position.x + s.normal.x * side + s.tangent.x * along,
        s.position.z + s.normal.z * side + s.tangent.z * along,
        rocky && !spawnClear ? 0.32 + rand(seed) * 0.48 : 0.16 + rand(seed) * 0.28,
      );
    }

    if (!spawnClear && (opening || rocky || rand(seed) > 0.4)) {
      const sign = rand(seed) < 0.5 ? -1 : 1;
      const dist = halfW + 1.1 + rand(seed) * 2.6;
      const along = (rand(seed) - 0.5) * 2.2;
      placeRock(
        s.position.x + s.normal.x * sign * dist + s.tangent.x * along,
        s.position.z + s.normal.z * sign * dist + s.tangent.z * along,
        1.25 + rand(seed) * 1.45,
      );
    }
  }

  let guard = 0;
  while (placed < WORLD.rockCount && guard++ < WORLD.rockCount * 10) {
    const x = (rand(seed) - 0.5) * WORLD.size * 0.88;
    const z = (rand(seed) - 0.5) * WORLD.size * 0.88;
    const infl = trail.influenceAt(x, z);
    if (infl.dist < infl.width * 0.55) continue;
    placeRock(x, z, 0.22 + rand(seed) * 1.1);
  }
  for (const mesh of rockMeshes) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  const colliderCandidates = [...rockPositions]
    .sort((a, b) => b.s - a.s)
    .slice(0, WORLD.colliderRockCount);
  for (const r of colliderCandidates) {
    const body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(r.x, r.y, r.z),
    );
    const rad = 0.5 * Math.max(r.sx, r.sy, r.sz);
    const rockCol = physics.createCollider(
      RAPIER.ColliderDesc.ball(rad).setFriction(1.05),
      body,
    );
    tagCollider(rockCol, 'rock');
    occluders.insert({ x: r.x, y: r.y - r.s * 0.4, z: r.z, radius: rad, height: r.sy * 1.2 });
  }

  // Fallen logs
  const barkMat = new THREE.MeshStandardMaterial({
    map: textures.bark,
    roughness: 0.94,
    metalness: 0.02,
    color: 0x9a7a58,
  });
  const logGeo = new THREE.CylinderGeometry(1, 0.85, 1, 8, 1);
  logGeo.rotateZ(Math.PI / 2);
  const branchGeo = new THREE.CylinderGeometry(0.12, 0.08, 1.6, 5);
  const logSamples = samples.filter((s) => s.kind === 'logs');
  const extraLogs = samples.filter((_, i) => i % 28 === 0);
  const logSpots = [...logSamples.filter((_, i) => i % 3 === 0), ...extraLogs.slice(0, 8)];

  let logs = 0;
  for (const s of logSpots) {
    if (logs >= WORLD.logCount) break;
    const across = rand(seed) < 0.55 && s.kind === 'logs';
    const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (across ? Math.PI / 2 : (rand(seed) - 0.5) * 0.6);
    const len = across ? s.width * (0.7 + rand(seed) * 0.5) : 3.5 + rand(seed) * 5;
    const rad = across ? 0.28 + rand(seed) * 0.22 : 0.16 + rand(seed) * 0.2;
    const x = s.position.x + s.normal.x * (rand(seed) - 0.5) * 1.4;
    const z = s.position.z + s.normal.z * (rand(seed) - 0.5) * 1.4;
    const y = heightAt(x, z) + rad * 0.45;
    const mesh = new THREE.Mesh(logGeo, barkMat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.scale.set(len, rad * 2, rad * 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (rand(seed) > 0.35) {
      const br = new THREE.Mesh(branchGeo, barkMat);
      br.position.set(x + Math.cos(yaw) * len * 0.2, y + rad * 0.8, z + Math.sin(yaw) * len * 0.2);
      br.rotation.set(0.6 + rand(seed) * 0.4, yaw, 0.3);
      br.castShadow = true;
      group.add(br);
    }

    const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const hx = len * 0.5;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    const logCol = physics.createCollider(
      RAPIER.ColliderDesc.capsule(Math.max(0.2, hx - rad), rad).setRotation({ x: 0, y: 0, z: 0.707, w: 0.707 }).setFriction(0.9),
      body,
    );
    tagCollider(logCol, 'wood');
    occluders.insert({ x, y: y - rad, z, radius: Math.max(rad, 0.4), height: rad * 2.2 });
    logs++;
  }

  // Small stones along trail (visual)
  const pebbleGeo = new THREE.DodecahedronGeometry(0.16, 0);
  const pebbleMat = new THREE.MeshStandardMaterial({
    map: textures.rock,
    roughness: 0.96,
    color: 0x8a8074,
  });
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, WORLD.pebbleCount);
  pebbles.castShadow = true;
  let pi = 0;
  for (const s of samples) {
    if (pi >= WORLD.pebbleCount) break;
    if (rand(seed) > 0.5) continue;
    const side = (rand(seed) - 0.5) * s.width;
    const x = s.position.x + s.normal.x * side;
    const z = s.position.z + s.normal.z * side;
    dummy.position.set(x, heightAt(x, z) + 0.05, z);
    dummy.scale.setScalar(0.45 + rand(seed) * 1.6);
    dummy.rotation.set(rand(seed), rand(seed) * 6, rand(seed));
    dummy.updateMatrix();
    pebbles.setMatrixAt(pi++, dummy.matrix);
  }
  pebbles.count = pi;
  group.add(pebbles);

  return {
    group,
    dispose() {
      group.removeFromParent();
      for (const g of rockGeos) g.dispose();
      rockMat.dispose();
      rockMatB.dispose();
      rockMatC.dispose();
      barkMat.dispose();
      logGeo.dispose();
      branchGeo.dispose();
      pebbleGeo.dispose();
      pebbleMat.dispose();
    },
  };
}
