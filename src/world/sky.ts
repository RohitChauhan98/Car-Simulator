import * as THREE from 'three';
import { WORLD } from '../config';

export type SkySystem = {
  sun: THREE.DirectionalLight;
  update: (dt: number, carPos?: THREE.Vector3) => void;
  dispose: () => void;
};

/**
 * Single haze color shared by fog, the sky horizon band, ridge bases and the
 * far terrain skirt, so the world fades into the sky with no visible seam.
 */
export const HORIZON_COLOR = new THREE.Color(0xa9c0b2);

/**
 * Distant mountain silhouette: a vertical triangle-strip ring with a jagged
 * ridge profile. Vertex colors fade from the exact horizon color at the base
 * (seamless against fog) to a slightly darker blue-grey at the crest.
 * fog:false — the atmospheric tint is baked into the vertex colors.
 */
function makeRidgeRing(
  radius: number,
  maxH: number,
  seed: number,
  colTop: THREE.Color,
  colBase: THREE.Color,
): THREE.Mesh {
  const SEG = 240;
  const positions = new Float32Array((SEG + 1) * 2 * 3);
  const colors = new Float32Array((SEG + 1) * 2 * 3);
  const indices: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const n =
      Math.sin(a * 3.1 + seed) * 0.45 +
      Math.sin(a * 7.7 + seed * 2.3) * 0.3 +
      Math.sin(a * 16.9 + seed * 4.7) * 0.25;
    const rn =
      Math.sin(a * 5.3 + seed * 1.7) * 0.6 +
      Math.sin(a * 12.7 + seed * 3.1) * 0.4;
    const r = radius + rn * radius * 0.07;
    const top = maxH * (0.45 + 0.55 * (n * 0.5 + 0.5));
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const o = i * 6;
    positions[o] = x; positions[o + 1] = -30; positions[o + 2] = z;
    positions[o + 3] = x; positions[o + 4] = top; positions[o + 5] = z;
    colors[o] = colBase.r; colors[o + 1] = colBase.g; colors[o + 2] = colBase.b;
    colors[o + 3] = colTop.r; colors[o + 4] = colTop.g; colors[o + 5] = colTop.b;
    if (i < SEG) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

/** Bright midday forest light matching the reference off-road shot. */
export function createSky(scene: THREE.Scene): SkySystem {
  scene.fog = new THREE.Fog(HORIZON_COLOR, WORLD.fogNear, WORLD.fogFar);
  scene.background = HORIZON_COLOR;

  const skyGeo = new THREE.SphereGeometry(2200, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x6a9aae) },
      uHorizon: { value: HORIZON_COLOR },
      uBottom: { value: new THREE.Color(0x6a7a58) },
    },
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uBottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 col = mix(uBottom, uHorizon, smoothstep(-0.15, 0.08, h));
        col = mix(col, uTop, smoothstep(0.08, 0.75, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // Layered ridge silhouettes replace the old flat cones: nearer rings are
  // darker/bluer, farther rings melt into the haze (atmospheric perspective).
  const ridgeTint = (toward: number, darken: number) =>
    HORIZON_COLOR.clone()
      .lerp(new THREE.Color(0x7d93a8), toward)
      .multiplyScalar(darken);
  const ridgeGroup = new THREE.Group();
  ridgeGroup.add(makeRidgeRing(1050, 150, 1.7, ridgeTint(0.45, 0.88), HORIZON_COLOR));
  ridgeGroup.add(makeRidgeRing(1500, 240, 4.2, ridgeTint(0.25, 0.94), HORIZON_COLOR));
  ridgeGroup.add(makeRidgeRing(2000, 330, 8.9, ridgeTint(0.12, 0.98), HORIZON_COLOR));
  scene.add(ridgeGroup);

  const hemi = new THREE.HemisphereLight(0xd8ead8, 0x3a4a28, 0.5);
  scene.add(hemi);

  const amb = new THREE.AmbientLight(0xc8d8b0, 0.16);
  scene.add(amb);

  const sun = new THREE.DirectionalLight(0xfff6e4, 1.42);
  sun.position.set(-180, 520, 220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 8;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -80;
  sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xb8d0e8, 0.35);
  fill.position.set(220, 120, -180);
  scene.add(fill);

  return {
    sun,
    update(_dt, carPos) {
      if (!carPos) return;
      sun.target.position.copy(carPos);
      sun.position.set(carPos.x - 160, carPos.y + 340, carPos.z + 180);
      sky.position.set(carPos.x, 0, carPos.z);
      ridgeGroup.position.set(carPos.x, 0, carPos.z);
    },
    dispose() {
      sky.removeFromParent();
      ridgeGroup.removeFromParent();
      ridgeGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      hemi.removeFromParent();
      amb.removeFromParent();
      sun.removeFromParent();
      fill.removeFromParent();
      skyGeo.dispose();
      skyMat.dispose();
    },
  };
}

export function applyCarEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = HORIZON_COLOR;

  const envSkyGeo = new THREE.SphereGeometry(8, 16, 10);
  const envSkyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x6a9aae) },
      uHorizon: { value: HORIZON_COLOR },
      uBottom: { value: new THREE.Color(0x6a7a58) },
    },
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uBottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 col = mix(uBottom, uHorizon, smoothstep(-0.15, 0.08, h));
        col = mix(col, uTop, smoothstep(0.08, 0.75, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(envSkyGeo, envSkyMat));
  envScene.add(new THREE.HemisphereLight(0xe7f1ff, 0x6a8a4a, 1.1));
  const envSun = new THREE.DirectionalLight(0xfff6e4, 2.1);
  envSun.position.set(-3, 7, 2);
  envScene.add(envSun);

  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  envSkyGeo.dispose();
  envSkyMat.dispose();
}
