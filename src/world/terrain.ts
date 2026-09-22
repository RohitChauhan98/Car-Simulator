import * as THREE from 'three';
import RAPIER, { World as RapierWorld } from '@dimforge/rapier3d-compat';
import { WORLD } from '../config';
import { TrailNetwork } from './trail';
import { createSky, type SkySystem, applyCarEnvironment } from './sky';
import { ParticleSystem, type DustSource } from './particles';
import { OcclusionHash } from './occlusion';
import { loadEnvTextures, loadEnvMap, type EnvTextures } from './assets';
import { createWater, type WaterSystem } from './water';
import { createObstacles, type ObstacleSystem } from './obstacles';
import { createVegetation, type VegetationSystem } from './vegetation';
import { tagCollider } from '../physics/materials';

/** Surface ids: 0 unused, 1 dirt, 2 gravel, 3 scree, 4 grass, 5 rock, 6 mud, 7 water */

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number, oct = 5): number {
  let a = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    a += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return a / norm;
}

export type TerrainSystem = {
  mesh: THREE.Mesh;
  trail: TrailNetwork;
  heightAt: (x: number, z: number) => number;
  surfaceAt: (x: number, z: number) => number;
  dispose: () => void;
};

function splatMaterial(textures: EnvTextures): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: textures.dirt,
    normalMap: textures.dirtN,
    roughness: 0.92,
    metalness: 0.03,
    envMapIntensity: 0.42,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDirt = { value: textures.dirt };
    shader.uniforms.uGrass = { value: textures.grass };
    shader.uniforms.uRock = { value: textures.rock };
    shader.uniforms.uMud = { value: textures.mud };
    shader.vertexShader = `
      attribute float aSurface;
      varying float vSurf;
      varying float vSlope;
      varying vec3 vWPos;
    ` + shader.vertexShader
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         vSurf = aSurface;`,
      )
      .replace(
        '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>
         vSlope = 1.0 - objectNormal.y;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = `
      uniform sampler2D uDirt;
      uniform sampler2D uGrass;
      uniform sampler2D uRock;
      uniform sampler2D uMud;
      varying float vSurf;
      varying float vSlope;
      varying vec3 vWPos;
    ` + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
        vec2 uv = vWPos.xz * 0.09;
        vec3 dirtC = texture2D(uDirt, uv).rgb;
        vec3 grassTex = texture2D(uGrass, uv * 1.2).rgb;
        vec3 rockC = texture2D(uRock, uv * 0.65).rgb;
        vec3 mudC = texture2D(uMud, uv * 1.05).rgb;
        vec3 grassC = mix(vec3(0.16, 0.30, 0.08), grassTex, 0.22);
        dirtC = mix(vec3(0.42, 0.34, 0.22), dirtC, 0.55);
        vec3 gravelC = mix(dirtC * vec3(0.92, 0.88, 0.80), rockC, 0.55);
        rockC = mix(vec3(0.55, 0.54, 0.50), rockC, 0.7);
        vec3 mudDark = mudC * vec3(0.52, 0.40, 0.30);
        float s = floor(vSurf + 0.5);
        vec3 col = grassC;
        if (s < 0.5) col = mix(grassC, dirtC, 0.55);
        else if (s < 1.5) col = mix(grassC, dirtC, 0.72);
        else if (s < 2.5) col = gravelC;
        else if (s < 3.5) col = mix(rockC, dirtC, 0.25);
        else if (s < 4.5) col = mix(grassC, dirtC, clamp(vSlope * 1.2, 0.0, 0.22));
        else if (s < 5.5) col = mix(rockC, grassC, 0.12);
        else if (s < 6.5) col = mudDark;
        else col = mix(mudDark, vec3(0.18, 0.24, 0.22), 0.45);
        col *= 1.0 - clamp(vSlope, 0.0, 1.0) * 0.18;
        diffuseColor.rgb *= col;
      `,
    );
  };
  mat.customProgramCacheKey = () => 'forest-splat-v6';
  return mat;
}

export function createTerrain(
  scene: THREE.Scene,
  physics: RapierWorld,
  trail: TrailNetwork,
  textures: EnvTextures,
): TerrainSystem {
  const N = WORLD.gridN;
  const size = WORLD.size;
  const half = size * 0.5;
  const heights = new Float32Array((N + 1) * (N + 1));
  const surfaces = new Uint8Array((N + 1) * (N + 1));
  const cell = size / N;

  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      const idx = iz * (N + 1) + ix;

      const n = fbm(x * 0.0038, z * 0.0038, 6);
      let h = 24 + n * 14;
      h += fbm(x * 0.011 + 18, z * 0.011, 4) * 7;
      h += (fbm(x * 0.028, z * 0.028, 2) - 0.5) * 5;

      const infl = trail.influenceAt(x, z);
      const halfW = infl.width * 0.5;

      if (infl.dist < halfW + 28) {
        const edge = Math.max(0, (infl.dist - halfW) / 28);
        const carve = 1 - edge * edge;
        h = h * (1 - carve * 0.62) + infl.heightHint * carve * 0.62;
      }

      if (infl.dist < halfW) {
        if (infl.kind === 'water') {
          h = infl.heightHint - 0.62 + (fbm(x * 0.14, z * 0.14, 2) - 0.5) * 0.1;
        } else {
          let bump = (fbm(x * 0.38, z * 0.38, 3) - 0.5) * 0.32;
          bump += Math.sin(x * 0.9 + z * 0.15) * 0.06;
          if (infl.kind === 'rocks' || infl.kind === 'descent') {
            bump += (fbm(x * 0.62, z * 0.62, 2) - 0.42) * 0.62;
          }
          if (infl.kind === 'steep' || infl.kind === 'climb') {
            bump += (fbm(x * 0.22, z * 0.22, 2) - 0.5) * 0.2;
          }
          if (infl.kind === 'mud') {
            bump *= 0.28;
            bump += Math.sin(x * 1.6) * Math.sin(z * 0.9) * 0.07;
          }
          if (infl.kind === 'logs') bump += (fbm(x * 0.5, z * 0.5, 2) - 0.5) * 0.16;
          h += bump;
        }
      }

      h = Math.max(h, 5);
      heights[idx] = h;

      let surf = 4;
      if (infl.dist < halfW * 0.38) {
        surf = infl.surface;
      } else if (infl.dist < halfW) {
        if (infl.kind === 'water') surf = 7;
        else if (infl.kind === 'mud') surf = 6;
        else if (infl.kind === 'rocks' || infl.kind === 'descent') surf = 5;
        else if (infl.surface === 2) surf = 2;
        else surf = 1;
      } else if (infl.dist < halfW + 3) {
        surf = infl.kind === 'water' || infl.kind === 'mud' ? 6 : 4;
      } else {
        const rocky = fbm(x * 0.02, z * 0.02, 2);
        if (rocky > 0.82) surf = 5;
        else surf = 4;
      }
      surfaces[idx] = surf;
    }
  }

  const geo = new THREE.PlaneGeometry(size, size, N, N);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const surfAttr = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const ix = Math.round((x + half) / cell);
    const iz = Math.round((z + half) / cell);
    const idx = Math.max(0, Math.min(N, iz)) * (N + 1) + Math.max(0, Math.min(N, ix));
    pos.setY(i, heights[idx]);
    surfAttr[i] = surfaces[idx];
  }
  geo.setAttribute('aSurface', new THREE.BufferAttribute(surfAttr, 1));
  geo.computeVertexNormals();

  const mat = splatMaterial(textures);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);

  const verts = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    verts[i * 3] = pos.getX(i);
    verts[i * 3 + 1] = pos.getY(i);
    verts[i * 3 + 2] = pos.getZ(i);
  }
  const index = geo.index!;
  const indices = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);

  const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const terrainCol = physics.createCollider(
    RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(1.05),
    body,
  );
  tagCollider(terrainCol, 'dirt');

  function heightAt(x: number, z: number): number {
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    if (x0 < 0 || z0 < 0 || x0 >= N || z0 >= N) return 14;
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = heights[z0 * (N + 1) + x0];
    const h10 = heights[z0 * (N + 1) + x0 + 1];
    const h01 = heights[(z0 + 1) * (N + 1) + x0];
    const h11 = heights[(z0 + 1) * (N + 1) + x0 + 1];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  }

  function surfaceAt(x: number, z: number): number {
    const ix = Math.round((x + half) / cell);
    const iz = Math.round((z + half) / cell);
    if (ix < 0 || iz < 0 || ix > N || iz > N) return 1;
    return surfaces[iz * (N + 1) + ix];
  }

  return {
    mesh,
    trail,
    heightAt,
    surfaceAt,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

export type SpawnPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export class World {
  readonly trail: TrailNetwork;
  readonly terrain: TerrainSystem;
  readonly water: WaterSystem;
  readonly vegetation: VegetationSystem;
  readonly obstacles: ObstacleSystem;
  readonly sky: SkySystem;
  readonly particles: ParticleSystem;
  readonly occluders: OcclusionHash;
  readonly textures: EnvTextures;

  private constructor(
    trail: TrailNetwork,
    terrain: TerrainSystem,
    water: WaterSystem,
    vegetation: VegetationSystem,
    obstacles: ObstacleSystem,
    sky: SkySystem,
    particles: ParticleSystem,
    occluders: OcclusionHash,
    textures: EnvTextures,
  ) {
    this.trail = trail;
    this.terrain = terrain;
    this.water = water;
    this.vegetation = vegetation;
    this.obstacles = obstacles;
    this.sky = sky;
    this.particles = particles;
    this.occluders = occluders;
    this.textures = textures;
  }

  static async create(
    scene: THREE.Scene,
    physics: RapierWorld,
    renderer?: THREE.WebGLRenderer,
  ): Promise<World> {
    const textures = await loadEnvTextures();
    if (renderer) {
      const hdr = await loadEnvMap(renderer);
      if (hdr) scene.environment = hdr;
      else applyCarEnvironment(renderer, scene);
    }

    const sky = createSky(scene);
    const trail = new TrailNetwork();
    const terrain = createTerrain(scene, physics, trail, textures);
    const water = createWater(scene, trail, terrain.heightAt);
    const occluders = new OcclusionHash(18);
    const vegetation = createVegetation(scene, physics, trail, terrain.heightAt, occluders, textures);
    const obstacles = createObstacles(scene, physics, trail, terrain.heightAt, occluders, textures);
    const particles = new ParticleSystem(scene);
    return new World(trail, terrain, water, vegetation, obstacles, sky, particles, occluders, textures);
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  surfaceAt(x: number, z: number): number {
    return this.terrain.surfaceAt(x, z);
  }

  waterHeightAt(x: number, z: number): number {
    return this.water.heightAt(x, z);
  }

  distanceToWater(x: number, z: number): number {
    return this.water.distTo(x, z);
  }

  getSpawnPose(): SpawnPose {
    const p = this.trail.spawnPoint();
    const y = this.terrain.heightAt(p.x, p.z) + 1.2;
    return { x: p.x, y, z: p.z, yaw: this.trail.spawnYaw() };
  }

  step(dt: number, carPos: THREE.Vector3) {
    this.vegetation.update(dt, carPos);
    this.sky.update(dt, carPos);
    this.water.update(dt);
  }

  updateParticles(
    sources: DustSource[],
    carVel: { x: number; z: number },
    dt: number,
  ) {
    this.particles.emitFromSources(sources, carVel);
    this.particles.emitWater(sources, carVel, (x, z) => this.water.heightAt(x, z));
    this.particles.update(dt);
  }

  dispose() {
    this.particles.dispose();
    this.vegetation.dispose();
    this.obstacles.dispose();
    this.water.dispose();
    this.sky.dispose();
    this.terrain.dispose();
  }
}

export async function createWorld(
  scene: THREE.Scene,
  rapierWorld: RapierWorld,
  renderer?: THREE.WebGLRenderer,
): Promise<World> {
  return World.create(scene, rapierWorld, renderer);
}
