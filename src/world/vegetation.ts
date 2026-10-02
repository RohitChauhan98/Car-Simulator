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

/**
 * Stacked-cone pine with jittered layer radii, offsets and spacing so trees
 * read as irregular evergreens instead of perfect cone stacks.
 */
function makePineFoliage(
  layers: number,
  baseRadius: number,
  seed: { n: number },
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let y = 3.1;
  for (let i = 0; i < layers; i++) {
    const t = i / Math.max(1, layers - 1);
    const r = baseRadius * (1 - t * 0.8) * (0.82 + rand(seed) * 0.36);
    const h = (1.05 + (1 - t) * 0.45) * (0.85 + rand(seed) * 0.3);
    const cone = new THREE.ConeGeometry(Math.max(0.18, r), h, 8);
    cone.translate(
      (rand(seed) - 0.5) * 0.5 * baseRadius,
      y,
      (rand(seed) - 0.5) * 0.5 * baseRadius,
    );
    y += 0.8 + rand(seed) * 0.35;
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

type WindUniforms = {
  uTime: { value: number };
  uCam: { value: THREE.Vector3 };
};

/**
 * Vertex wind sway + camera-distance fade for card foliage (instanced quads).
 * Instances keep fixed world transforms; the shader bends blades by height with
 * a world-position phase, and shrinks tufts past the fade range so distant
 * cards never shimmer or cost fill rate.
 */
function addWindSway(
  mat: THREE.MeshStandardMaterial,
  wind: WindUniforms,
  opts: { strength: number; bladeHeight: number; fadeNear: number; fadeFar: number; cacheKey: string },
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = wind.uTime;
    shader.uniforms.uWindCam = wind.uCam;
    shader.vertexShader =
      'uniform float uWindTime;\nuniform vec3 uWindCam;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 iOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float phase = iOrigin.x * 0.35 + iOrigin.z * 0.27;
          float sway = sin(uWindTime * 1.7 + phase) * 0.6
                     + sin(uWindTime * 3.1 + iOrigin.x * 0.9 - iOrigin.z * 0.6) * 0.4;
          float bend = smoothstep(0.0, ${opts.bladeHeight.toFixed(2)}, transformed.y);
          transformed.x += sway * ${opts.strength.toFixed(3)} * bend;
          transformed.z += sway * ${(opts.strength * 0.6).toFixed(3)} * bend;
          float dCam = distance(iOrigin.xz, uWindCam.xz);
          transformed *= 1.0 - smoothstep(${opts.fadeNear.toFixed(1)}, ${opts.fadeFar.toFixed(1)}, dCam);
        }`,
      );
  };
  mat.customProgramCacheKey = () => opts.cacheKey;
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
  const wind: WindUniforms = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
  };

  const trunkGeo = makePineTrunk();
  const foliageA = makePineFoliage(7, 1.08, { n: 11 });
  const foliageB = makePineFoliage(6, 0.88, { n: 23 });

  const trunkMat = new THREE.MeshStandardMaterial({
    map: textures.bark,
    roughness: 0.9,
    metalness: 0.02,
    color: 0xc4a070,
  });
  const pineMatA = new THREE.MeshStandardMaterial({
    color: 0x38512c,
    roughness: 0.82,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  const pineMatB = new THREE.MeshStandardMaterial({
    color: 0x2c4524,
    roughness: 0.84,
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
    dummy.rotation.set(
      (rand(seed) - 0.5) * 0.07,
      rand(seed) * Math.PI * 2,
      (rand(seed) - 0.5) * 0.07,
    );
    dummy.updateMatrix();
    trunks.setMatrixAt(treeI, dummy.matrix);
    color.setHSL(0.08, 0.38, 0.38 + rand(seed) * 0.16);
    trunks.setColorAt(treeI, color);

    const foliage = treeI % 2 === 0 ? canopy0 : canopy1;
    const fi = foliage.count;
    foliage.setMatrixAt(fi, dummy.matrix);
    color.setHSL(0.26 + rand(seed) * 0.06, 0.38, 0.24 + rand(seed) * 0.12);
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
    color: 0x36592c,
    roughness: 0.88,
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
    color.setHSL(0.26, 0.38, 0.26 + rand(seed) * 0.1);
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
    color.setHSL(0.26, 0.38, 0.26 + rand(seed) * 0.1);
    bushes.setColorAt(bi, color);
    bi++;
  }
  bushes.count = bi;
  if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
  group.add(bushes);

  const fernGeo = makeFernGeo();
  const fernMat = new THREE.MeshStandardMaterial({
    map: textures.leaf,
    color: 0x40662f,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    alphaTest: 0.25,
  });
  addWindSway(fernMat, wind, {
    strength: 0.045,
    bladeHeight: 0.7,
    fadeNear: 60,
    fadeFar: 95,
    cacheKey: 'wind-fern',
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
    color: 0x9fb36a,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
    alphaTest: 0.32,
  });
  addWindSway(grassMat, wind, {
    strength: 0.09,
    bladeHeight: 0.5,
    fadeNear: 55,
    fadeFar: 80,
    cacheKey: 'wind-grass',
  });
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, WORLD.grassCount);
  grass.frustumCulled = false;
  group.add(grass);

  // Fixed world-space scatter, written once: a dense band along the trail
  // corridor plus a sparse far field. Instances never move after this — only
  // the wind shader animates them — so grass no longer follows the vehicle.
  let gi = 0;
  const nearTarget = (WORLD.grassCount * 0.68) | 0;
  const perSample = Math.max(1, Math.ceil(nearTarget / samples.length));
  for (const s of samples) {
    if (gi >= nearTarget) break;
    const halfW = s.width * 0.5;
    for (let k = 0; k < perSample && gi < nearTarget; k++) {
      const sign = rand(seed) < 0.5 ? -1 : 1;
      const dist = halfW - 0.4 + rand(seed) * (rand(seed) < 0.7 ? 7 : 22);
      const along = (rand(seed) - 0.5) * 6;
      const x = s.position.x + s.normal.x * sign * dist + s.tangent.x * along;
      const z = s.position.z + s.normal.z * sign * dist + s.tangent.z * along;
      if (Math.abs(x) > half - 12 || Math.abs(z) > half - 12) continue;
      const infl = trail.influenceAt(x, z);
      if (infl.kind === 'water' && infl.dist < infl.width * 0.55) continue;
      if (infl.dist < infl.width * 0.32 && rand(seed) > 0.22) continue;
      const onTrack = infl.dist < infl.width * 0.5;
      const h = onTrack ? 0.18 + rand(seed) * 0.14 : 0.32 + rand(seed) * 0.28;
      dummy.position.set(x, heightAt(x, z), z);
      dummy.scale.set(0.55 + rand(seed) * 0.4, h, 1);
      dummy.rotation.set(0, rand(seed) * Math.PI * 2, (rand(seed) - 0.5) * 0.12);
      dummy.updateMatrix();
      grass.setMatrixAt(gi++, dummy.matrix);
    }
  }
  let grassGuard = 0;
  while (gi < WORLD.grassCount && grassGuard++ < WORLD.grassCount * 8) {
    const x = (rand(seed) - 0.5) * (WORLD.size - 24);
    const z = (rand(seed) - 0.5) * (WORLD.size - 24);
    const infl = trail.influenceAt(x, z);
    if (infl.dist < infl.width * 0.5 + 1.5) continue;
    if (infl.kind === 'water' && infl.dist < infl.width * 2) continue;
    dummy.position.set(x, heightAt(x, z), z);
    dummy.scale.set(0.55 + rand(seed) * 0.45, 0.3 + rand(seed) * 0.3, 1);
    dummy.rotation.set(0, rand(seed) * Math.PI * 2, (rand(seed) - 0.5) * 0.12);
    dummy.updateMatrix();
    grass.setMatrixAt(gi++, dummy.matrix);
  }
  grass.count = gi;

  return {
    group,
    update(dt, carPos) {
      wind.uTime.value += dt;
      wind.uCam.value.copy(carPos);
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
