import * as THREE from 'three';
import RAPIER, { World as RapierWorld } from '@dimforge/rapier3d-compat';
import { WORLD } from '../config';
import { RoadNetwork } from './road';
import { createProps, type PropsSystem } from './props';
import { createSky, type SkySystem } from './sky';
import { ParticleSystem, type DustSource } from './particles';

/** Surface ids: 0 tarmac, 1 dirt, 2 gravel, 3 scree, 4 grass, 5 rock */

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

function makeCanvasTexture(
  size: number,
  paint: (ctx: CanvasRenderingContext2D, s: number) => void,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function rockTex() {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#6a635c';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const g = 80 + Math.random() * 70;
      ctx.fillStyle = `rgb(${g},${g - 8},${g - 16})`;
      ctx.fillRect(x, y, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }
  });
}

function dirtTex() {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#8a6b45';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 1200; i++) {
      ctx.fillStyle = `rgba(${100 + Math.random() * 60},${70 + Math.random() * 40},${40 + Math.random() * 30},${0.3 + Math.random() * 0.5})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
  });
}

function grassTex() {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#4a6b3a';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2000; i++) {
      ctx.strokeStyle = `rgba(${40 + Math.random() * 50},${90 + Math.random() * 80},${30 + Math.random() * 40},0.5)`;
      const x = Math.random() * s, y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 4, y - 3 - Math.random() * 5);
      ctx.stroke();
    }
  });
}

function tarmacTex() {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#3a3a3c';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 800; i++) {
      const g = 45 + Math.random() * 35;
      ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
    }
    // faint center dashes feel via noise patches
    ctx.fillStyle = 'rgba(200,180,60,0.15)';
    for (let y = 0; y < s; y += 32) ctx.fillRect(s * 0.48, y, 4, 14);
  });
}

export type TerrainSystem = {
  mesh: THREE.Mesh;
  water: THREE.Mesh;
  heightAt: (x: number, z: number) => number;
  surfaceAt: (x: number, z: number) => number;
  road: RoadNetwork;
  dispose: () => void;
};

/**
 * Heightmap WORLD.gridN over WORLD.size: fBm mountains, valley, river,
 * road carving, surface ids, splat shader, trimesh collider, water.
 */
export function createTerrain(scene: THREE.Scene, physics: RapierWorld): TerrainSystem {
  const N = WORLD.gridN;
  const size = WORLD.size;
  const half = size * 0.5;
  const road = new RoadNetwork();

  const heights = new Float32Array((N + 1) * (N + 1));
  const surfaces = new Uint8Array((N + 1) * (N + 1));

  const cell = size / N;

  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      const idx = iz * (N + 1) + ix;

      // Mountain fBm
      const n = fbm(x * 0.0035, z * 0.0035, 6);
      let h = n * 220;

      // Valley trench along valleyLineZ
      const valleyDist = Math.abs(z - WORLD.valleyLineZ);
      const valley = Math.exp(-((valleyDist / 95) ** 2));
      h = h * (1 - 0.85 * valley) + 18 * (1 - valley * 0.5);

      // Side ridges
      const ridge = fbm(x * 0.008 + 20, z * 0.008, 3);
      h += ridge * 40 * (1 - valley);

      // River bed
      const riverDist = Math.abs(z - WORLD.riverZ);
      if (riverDist < WORLD.riverHalfWidth * 2.2) {
        const rw = 1 - riverDist / (WORLD.riverHalfWidth * 2.2);
        h -= rw * rw * 14;
      }

      // Road carving
      const infl = road.influenceAt(x, z);
      const halfW = infl.width * 0.5;
      if (infl.dist < halfW + 10) {
        const edge = Math.max(0, (infl.dist - halfW) / 10);
        const carve = 1 - edge * edge;
        const target = infl.heightHint;
        h = h * (1 - carve * 0.92) + target * carve * 0.92;
        // flatten
        if (infl.dist < halfW) {
          h = target * 0.7 + h * 0.3;
        }
      }

      // Soft floor
      h = Math.max(h, 5);
      heights[idx] = h;

      // Surface assignment
      let surf = 4; // grass default
      if (infl.dist < halfW) {
        surf = infl.surface; // tarmac or gravel branch
      } else if (infl.dist < halfW + 4) {
        surf = 1; // dirt shoulder
      } else if (riverDist < WORLD.riverHalfWidth + 6) {
        surf = 2; // gravel near river
      } else {
        const slopeProxy = fbm(x * 0.02, z * 0.02, 2);
        if (h > 160 && slopeProxy > 0.55) surf = 3; // scree
        else if (h > 140) surf = 5; // rock
        else if (valley > 0.35) surf = 1; // dirt valley
        else surf = 4;
      }
      surfaces[idx] = surf;
    }
  }

  // Build Three mesh
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

  const texRock = rockTex();
  const texDirt = dirtTex();
  const texGrass = grassTex();
  const texTarmac = tarmacTex();
  texRock.repeat.set(40, 40);
  texDirt.repeat.set(40, 40);
  texGrass.repeat.set(50, 50);
  texTarmac.repeat.set(20, 20);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uRock: { value: texRock },
      uDirt: { value: texDirt },
      uGrass: { value: texGrass },
      uTarmac: { value: texTarmac },
      uFogColor: { value: new THREE.Color(0xb8c4ce) },
      uFogNear: { value: WORLD.fogNear },
      uFogFar: { value: WORLD.fogFar },
    },
    vertexShader: /* glsl */`
      attribute float aSurface;
      varying vec2 vUv;
      varying float vSurf;
      varying float vSlope;
      varying float vH;
      varying float vFog;
      uniform float uFogNear;
      uniform float uFogFar;
      void main() {
        vUv = uv * 40.0;
        vSurf = aSurface;
        vH = position.y;
        vec3 n = normalize(normal);
        vSlope = 1.0 - n.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFog = smoothstep(uFogNear, uFogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uRock, uDirt, uGrass, uTarmac;
      uniform vec3 uFogColor;
      varying vec2 vUv;
      varying float vSurf;
      varying float vSlope;
      varying float vH;
      varying float vFog;
      void main() {
        vec3 rock = texture2D(uRock, vUv).rgb;
        vec3 dirt = texture2D(uDirt, vUv).rgb;
        vec3 grass = texture2D(uGrass, vUv).rgb;
        vec3 tarmac = texture2D(uTarmac, vUv * 0.5).rgb;
        vec3 col = grass;
        float s = floor(vSurf + 0.5);
        if (s < 0.5) col = tarmac;
        else if (s < 1.5) col = dirt;
        else if (s < 2.5) col = mix(dirt, rock, 0.45);
        else if (s < 3.5) col = mix(rock, dirt, 0.3);
        else if (s < 4.5) col = mix(grass, dirt, clamp(vSlope * 2.0, 0.0, 0.6));
        else col = rock;
        // slope darkening / AO approx
        col *= 1.0 - vSlope * 0.35;
        col *= 0.85 + 0.15 * smoothstep(20.0, 180.0, vH);
        col = mix(col, uFogColor, vFog);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Water plane along river
  const waterGeo = new THREE.PlaneGeometry(size * 0.85, WORLD.riverHalfWidth * 2.4, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x3a6a7a,
    transparent: true,
    opacity: 0.72,
    roughness: 0.25,
    metalness: 0.1,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  // Sample average river height
  let wh = 0, wc = 0;
  for (let ix = 0; ix <= N; ix += 8) {
    const x = -half + ix * cell;
    const iz = Math.round((WORLD.riverZ + half) / cell);
    wh += heights[iz * (N + 1) + ix];
    wc++;
  }
  water.position.set(0, wh / wc + 0.6, WORLD.riverZ);
  scene.add(water);

  // Trimesh collider from same heights
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
  physics.createCollider(
    RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(1.0),
    body,
  );

  function heightAt(x: number, z: number): number {
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    if (x0 < 0 || z0 < 0 || x0 >= N || z0 >= N) return 20;
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
    water,
    heightAt,
    surfaceAt,
    road,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      waterGeo.dispose();
      waterMat.dispose();
      texRock.dispose();
      texDirt.dispose();
      texGrass.dispose();
      texTarmac.dispose();
    },
  };
}

export type SpawnPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

/**
 * Full Himalayan world: terrain + props + sky + dust particles.
 * Prefer this factory when wiring a new entrypoint; existing main.ts may
 * still compose createTerrain / createProps / createSky separately.
 */
export class World {
  readonly terrain: TerrainSystem;
  readonly props: PropsSystem;
  readonly sky: SkySystem;
  readonly particles: ParticleSystem;

  constructor(scene: THREE.Scene, physics: RapierWorld) {
    this.sky = createSky(scene);
    this.terrain = createTerrain(scene, physics);
    this.props = createProps(
      scene,
      physics,
      this.terrain.road,
      this.terrain.heightAt,
      this.terrain.surfaceAt,
    );
    this.particles = new ParticleSystem(scene);
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  surfaceAt(x: number, z: number): number {
    return this.terrain.surfaceAt(x, z);
  }

  getSpawnPose(): SpawnPose {
    const p = this.terrain.road.spawnPoint();
    const y = this.terrain.heightAt(p.x, p.z) + 1.2;
    return { x: p.x, y, z: p.z, yaw: this.terrain.road.spawnYaw() };
  }

  /** Per-frame env update: props, prayer-flag wind, sun follow. */
  step(dt: number, carPos: THREE.Vector3) {
    this.props.update(dt, carPos);
    this.sky.update(dt, carPos);
  }

  /** Emit + advance dust from external wheel sources. */
  updateParticles(
    sources: DustSource[],
    carVel: { x: number; z: number },
    dt: number,
  ) {
    this.particles.emitFromSources(sources, carVel);
    this.particles.update(dt);
  }

  dispose() {
    this.particles.dispose();
    this.props.dispose();
    this.sky.dispose();
    this.terrain.dispose();
  }
}

export function createWorld(scene: THREE.Scene, rapierWorld: RapierWorld): World {
  return new World(scene, rapierWorld);
}
