import * as THREE from 'three';
import type { TrailNetwork } from './trail';

export type WaterPatch = {
  x: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
  height: number;
};

export type WaterSystem = {
  group: THREE.Group;
  patches: WaterPatch[];
  heightAt: (x: number, z: number) => number;
  distTo: (x: number, z: number) => number;
  update: (dt: number) => void;
  dispose: () => void;
};

function inPatch(p: WaterPatch, x: number, z: number): boolean {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(-p.yaw);
  const s = Math.sin(-p.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) < p.width * 0.5 && Math.abs(lz) < p.length * 0.5;
}

/**
 * Trail-aligned water patches with a cheap ripple/fresnel shader.
 */
export function createWater(
  scene: THREE.Scene,
  trail: TrailNetwork,
  heightAt: (x: number, z: number) => number,
): WaterSystem {
  const group = new THREE.Group();
  scene.add(group);
  const patches: WaterPatch[] = [];

  const waterSamples = trail.sample(200).filter((s) => s.kind === 'water');
  for (let i = 0; i < waterSamples.length; i++) {
    const s = waterSamples[i];
    const h = heightAt(s.position.x, s.position.z) + 0.28;
    patches.push({
      x: s.position.x,
      z: s.position.z,
      yaw: Math.atan2(s.tangent.x, s.tangent.z),
      length: 22,
      width: s.width + 7.5,
      height: h,
    });
  }

  // Side creek feeding the crossing
  if (waterSamples.length > 4) {
    const mid = waterSamples[Math.floor(waterSamples.length * 0.4)];
    const n = mid.normal;
    for (let k = -2; k <= 3; k++) {
      const x = mid.position.x + n.x * (8 + k * 6);
      const z = mid.position.z + n.z * (8 + k * 6);
      patches.push({
        x, z,
        yaw: Math.atan2(n.x, n.z),
        length: 9,
        width: 4.2,
        height: heightAt(x, z) + 0.16,
      });
    }
  }

  const uniforms = {
    uTime: { value: 0 },
    uColorDeep: { value: new THREE.Color(0x143e4a) },
    uColorShallow: { value: new THREE.Color(0x3a7a72) },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    lights: false,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vN;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position;
        p.z += sin(uTime * 1.4 + position.x * 1.8 + position.y * 1.1) * 0.045;
        p.z += sin(uTime * 0.7 + position.x * 0.4) * 0.03;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        vec4 mv = viewMatrix * world;
        gl_Position = projectionMatrix * mv;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColorDeep;
      uniform vec3 uColorShallow;
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vN;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(0.0, dot(view, vec3(0.0, 1.0, 0.0))), 2.4);
        float ripple = sin(vWorld.x * 3.2 + uTime * 2.0) * sin(vWorld.z * 2.7 + uTime * 1.6);
        vec3 col = mix(uColorDeep, uColorShallow, 0.35 + ripple * 0.08);
        col += vec3(0.35, 0.5, 0.48) * fres * 0.55;
        float alpha = 0.72 + fres * 0.2;
        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
      }
    `,
  });

  for (const p of patches) {
    const geo = new THREE.PlaneGeometry(p.width, p.length, 8, 12);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.set(-Math.PI / 2, p.yaw, 0);
    mesh.position.set(p.x, p.height, p.z);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  function heightAtWater(x: number, z: number): number {
    let h = Number.NEGATIVE_INFINITY;
    for (const p of patches) {
      if (inPatch(p, x, z)) h = Math.max(h, p.height);
    }
    return h;
  }

  function distTo(x: number, z: number): number {
    let best = 1e9;
    for (const p of patches) {
      const d = Math.hypot(p.x - x, p.z - z) - Math.max(p.width, p.length) * 0.35;
      if (d < best) best = d;
    }
    return best;
  }

  return {
    group,
    patches,
    heightAt: heightAtWater,
    distTo,
    update(dt) {
      uniforms.uTime.value += dt;
    },
    dispose() {
      group.removeFromParent();
      mat.dispose();
      for (const child of group.children) {
        const m = child as THREE.Mesh;
        m.geometry.dispose();
      }
    },
  };
}
