import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

export type VegetationSystem = {
  group: THREE.Group;
  update: (dt: number, carPos: THREE.Vector3) => void;
  dispose: () => void;
};

/** Stacked-cone pine, close to the reference evergreen silhouette. */
function makePineFoliage(layers: number, baseRadius: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < layers; i++) {
    const t = i / Math.max(1, layers - 1);
    const r = baseRadius * (1 - t * 0.8);
    const h = 1.05 + (1 - t) * 0.45;
    const cone = new THREE.ConeGeometry(Math.max(0.18, r), h, 8);
    cone.translate(0, 3.2 + i * 0.95, 0);
    parts.push(cone);
  }
  const geo = mergeGeometries(parts);
  if (!geo) return new THREE.ConeGeometry(baseRadius, 4, 8);
  geo.computeVertexNormals();
  return geo;
}

function makePineTrunk(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.1, 0.2, 5.6, 7);
  g.translate(0, 2.8, 0);
  return g;
}

function makeFernGeo(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(0.55, 0.7);
  a.translate(0, 0.35, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const geo = mergeGeometries([a, b]);
  a.dispose();
  if (!geo) return new THREE.PlaneGeometry(0.55, 0.7);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tall pines hugging the trail so spawn reads as a forest corridor, not a prairie.
 */
export function createVegetation(
  scene: THREE.Scene,
  physics: RapierWorld,
  trail: TrailNetwork,
  heightAt: (x: number, z: number) => number,
  occluders: OcclusionHash,
  textures: EnvTextures,
  seedN = 42,
): VegetationSystem {
  const group = new THREE.Group();
  scene.add(group);
  const seed = { n: seedN };
  const dummy = new THREE.Object3D();
  const half = WORLD.size * 0.5;
  const color = new THREE.Color();

  const trunkGeo = makePineTrunk();
  const foliageA = makePineFoliage(7, 1.08);
  const foliageB = makePineFoliage(6, 0.88);

  const trunkMat = new THREE.MeshStandardMaterial({
    map: textures.bark,
    roughness: 0.9,
    metalness: 0.02,
    color: 0xc4a070,
  });
  const pineMatA = new THREE.MeshStandardMaterial({
    color: 0x3d6b32,
    roughness: 0.78,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  const pineMatB = new THREE.MeshStandardMaterial({
    color: 0x2f5a28,
    roughness: 0.8,
    metalness: 0,
    envMapIntensity: 0.35,
  });

  const nTree = WORLD.treeCount;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, nTree);
  const canopy0 = new THREE.InstancedMesh(foliageA, pineMatA, nTree);
  const canopy1 = new THREE.InstancedMesh(foliageB, pineMatB, nTree);
  trunks.castShadow = canopy0.castShadow = canopy1.castShadow = true;
  trunks.receiveShadow = canopy0.receiveShadow = canopy1.receiveShadow = true;
  trunks.count = 0;
  canopy0.count = 0;
  canopy1.count = 0;

  const placeTree = (x: number, z: number, s: number) => {
    if (treeI >= nTree) return false;
    if (Math.abs(x) > half - 30 || Math.abs(z) > half - 30) return false;
    const y = heightAt(x, z);
    if (y > 140) return false;

    dummy.position.set(x, y, z);
    dummy.scale.set(s * 0.72, s * 1.12, s * 0.72);
    dummy.rotation.set(0, rand(seed) * Math.PI * 2, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(treeI, dummy.matrix);
    color.setHSL(0.08, 0.38, 0.38 + rand(seed) * 0.16);
    trunks.setColorAt(treeI, color);

    const foliage = treeI % 2 === 0 ? canopy0 : canopy1;
    const fi = foliage.count;
    foliage.setMatrixAt(fi, dummy.matrix);
    color.setHSL(0.27 + rand(seed) * 0.07, 0.52, 0.26 + rand(seed) * 0.14);
    foliage.setColorAt(fi, color);
    foliage.count++;

    occluders.insert({ x, y, z, radius: 1.35 * s * 0.72, height: 11 * s });
    const infl = trail.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 12) {
      const body = physics.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + 2.6 * s, z),
      );
      const treeCol = physics.createCollider(
        RAPIER.ColliderDesc.capsule(2.2 * s, 0.22 * s).setFriction(0.65),
        body,
      );
      tagCollider(treeCol, 'wood');
    }
    treeI++;
    return true;
  };

  let treeI = 0;
  const samples = trail.sample(320);
  const corridor = 3.15;

  for (const s of samples) {
    if (treeI >= nTree * 0.55) break;
    const halfW = s.width * 0.5;
    for (const sign of [-1, 1] as const) {
      const extra = corridor + rand(seed) * 2.4;
      const along = (rand(seed) - 0.5) * 2.8;
      placeTree(
        s.position.x + s.normal.x * sign * (halfW + extra) + s.tangent.x * along,
        s.position.z + s.normal.z * sign * (halfW + extra) + s.tangent.z * along,
        2.35 + rand(seed) * 1.35,
      );
      if (rand(seed) > 0.35) {
        const farther = halfW + 5.5 + rand(seed) * 6;
        placeTree(
          s.position.x + s.normal.x * sign * farther,
          s.position.z + s.normal.z * sign * farther,
          1.7 + rand(seed) * 1.4,
        );
      }
    }
  }

  let bandGuard = 0;
  while (treeI < nTree * 0.82 && bandGuard++ < nTree * 20) {
    const s = samples[(rand(seed) * samples.length) | 0];
    const dist = s.width * 0.5 + 8 + rand(seed) * 17;
    const sign = rand(seed) < 0.5 ? -1 : 1;
    const along = (rand(seed) - 0.5) * 10;
    placeTree(
      s.position.x + s.normal.x * sign * dist + s.tangent.x * along,
      s.position.z + s.normal.z * sign * dist + s.tangent.z * along,
      1.5 + rand(seed) * 1.6,
    );
  }

  let farGuard = 0;
  while (treeI < nTree && farGuard++ < nTree * 24) {
    const x = (rand(seed) - 0.5) * WORLD.size * 0.9;
    const z = (rand(seed) - 0.5) * WORLD.size * 0.9;
    const infl = trail.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 6) continue;
    placeTree(x, z, 1.15 + rand(seed) * 1.5);
  }

  trunks.count = treeI;
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
  if (canopy0.instanceColor) canopy0.instanceColor.needsUpdate = true;
  if (canopy1.instanceColor) canopy1.instanceColor.needsUpdate = true;
  group.add(trunks, canopy0, canopy1);

  const bushGeo = new THREE.SphereGeometry(0.55, 6, 5);
  bushGeo.scale(1, 0.72, 1);
  const bushMat = new THREE.MeshStandardMaterial({
    color: 0x3a6e30,
    roughness: 0.86,
  });
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, WORLD.bushCount);
  bushes.castShadow = true;
  let bi = 0;
  for (const s of samples) {
    if (bi >= WORLD.bushCount) break;
    if (rand(seed) > 0.42) continue;
    const halfW = s.width * 0.5;
    const sign = rand(seed) < 0.5 ? -1 : 1;
    const dist = halfW + 0.35 + rand(seed) * 3.2;
    const x = s.position.x + s.normal.x * sign * dist;
    const z = s.position.z + s.normal.z * sign * dist;
    dummy.position.set(x, heightAt(x, z) + 0.28, z);
    dummy.scale.set(0.8 + rand(seed) * 1.5, 0.55 + rand(seed) * 0.7, 0.8 + rand(seed) * 1.5);
    dummy.rotation.set(0, rand(seed) * 6, 0);
    dummy.updateMatrix();
    bushes.setMatrixAt(bi, dummy.matrix);
    color.setHSL(0.28, 0.5, 0.28 + rand(seed) * 0.12);
    bushes.setColorAt(bi, color);
    bi++;
  }
  let bushGuard = 0;
  while (bi < WORLD.bushCount && bushGuard++ < WORLD.bushCount * 16) {
    const x = (rand(seed) - 0.5) * WORLD.size * 0.88;
    const z = (rand(seed) - 0.5) * WORLD.size * 0.88;
    const infl = trail.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 0.6) continue;
    dummy.position.set(x, heightAt(x, z) + 0.28, z);
    dummy.scale.set(0.7 + rand(seed) * 1.4, 0.5 + rand(seed) * 0.65, 0.7 + rand(seed) * 1.4);
    dummy.rotation.set(0, rand(seed) * 6, 0);
    dummy.updateMatrix();
    bushes.setMatrixAt(bi, dummy.matrix);
    color.setHSL(0.28, 0.5, 0.28 + rand(seed) * 0.12);
    bushes.setColorAt(bi, color);
    bi++;
  }
  bushes.count = bi;
  if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
  group.add(bushes);

  const fernGeo = makeFernGeo();
  const fernMat = new THREE.MeshStandardMaterial({
    map: textures.leaf,
    color: 0x4a7a38,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    alphaTest: 0.25,
  });
  const ferns = new THREE.InstancedMesh(fernGeo, fernMat, WORLD.fernCount);
  ferns.castShadow = true;
  let fi = 0;
  for (const s of samples) {
    if (fi >= WORLD.fernCount) break;
    if (rand(seed) > 0.38) continue;
    const halfW = s.width * 0.5;
    const sign = rand(seed) < 0.5 ? -1 : 1;
    const dist = halfW - 0.15 + rand(seed) * 2.4;
    const x = s.position.x + s.normal.x * sign * dist + s.tangent.x * (rand(seed) - 0.5) * 2;
    const z = s.position.z + s.normal.z * sign * dist + s.tangent.z * (rand(seed) - 0.5) * 2;
    dummy.position.set(x, heightAt(x, z), z);
    dummy.scale.setScalar(0.85 + rand(seed) * 0.9);
    dummy.rotation.set(0, rand(seed) * 6.28, (rand(seed) - 0.5) * 0.2);
    dummy.updateMatrix();
    ferns.setMatrixAt(fi++, dummy.matrix);
  }
  ferns.count = fi;
  group.add(ferns);

  const grassGeo = new THREE.PlaneGeometry(0.48, 0.52);
  grassGeo.translate(0, 0.24, 0);
  const grassMat = new THREE.MeshStandardMaterial({
    map: textures.grassCard,
    color: 0xb7d070,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
    alphaTest: 0.32,
  });
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, WORLD.grassCount);
  grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  grass.frustumCulled = false;
  group.add(grass);
  const grassSeed = { n: 77 };

  function scatterGrass(carPos: THREE.Vector3) {
    const R = WORLD.grassRadius;
    for (let i = 0; i < WORLD.grassCount; i++) {
      const ang = rand(grassSeed) * Math.PI * 2;
      const rad = Math.sqrt(rand(grassSeed)) * R;
      const x = carPos.x + Math.cos(ang) * rad;
      const z = carPos.z + Math.sin(ang) * rad;
      const infl = trail.influenceAt(x, z);
      if (infl.kind === 'water' && infl.dist < infl.width * 0.55) {
        dummy.scale.set(0, 0, 0);
      } else if (infl.dist < infl.width * 0.32 && rand(grassSeed) > 0.22) {
        dummy.scale.set(0, 0, 0);
      } else {
        dummy.position.set(x, heightAt(x, z), z);
        const onTrack = infl.dist < infl.width * 0.5;
        const h = onTrack ? 0.18 + rand(grassSeed) * 0.14 : 0.32 + rand(grassSeed) * 0.28;
        dummy.scale.set(0.55 + rand(grassSeed) * 0.4, h, 1);
        dummy.rotation.set(0, ang + (i % 2) * 1.2, (rand(grassSeed) - 0.5) * 0.12);
      }
      dummy.updateMatrix();
      grass.setMatrixAt(i, dummy.matrix);
    }
    grass.instanceMatrix.needsUpdate = true;
    grassSeed.n = 77;
  }

  let lastGrassX = 1e9;
  let lastGrassZ = 1e9;
  scatterGrass(new THREE.Vector3());

  return {
    group,
    update(_dt, carPos) {
      if (Math.hypot(carPos.x - lastGrassX, carPos.z - lastGrassZ) > 7) {
        lastGrassX = carPos.x;
        lastGrassZ = carPos.z;
        scatterGrass(carPos);
      }
    },
    dispose() {
      group.removeFromParent();
      trunkGeo.dispose();
      foliageA.dispose();
      foliageB.dispose();
      trunkMat.dispose();
      pineMatA.dispose();
      pineMatB.dispose();
      bushGeo.dispose();
      bushMat.dispose();
      fernGeo.dispose();
      fernMat.dispose();
      grassGeo.dispose();
      grassMat.dispose();
    },
  };
}
