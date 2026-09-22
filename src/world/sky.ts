import * as THREE from 'three';
import { WORLD } from '../config';

export type SkySystem = {
  sun: THREE.DirectionalLight;
  update: (dt: number, carPos?: THREE.Vector3) => void;
  dispose: () => void;
};

/** Bright midday forest light matching the reference off-road shot. */
export function createSky(scene: THREE.Scene): SkySystem {
  const fogCol = 0x9bb8a8;
  scene.fog = new THREE.Fog(fogCol, WORLD.fogNear, WORLD.fogFar);
  scene.background = new THREE.Color(0x8aab9a);

  const skyGeo = new THREE.SphereGeometry(2200, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x6a9aae) },
      uHorizon: { value: new THREE.Color(0xb8cfc0) },
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

  const peakGroup = new THREE.Group();
  const peakMat = new THREE.MeshBasicMaterial({ color: 0x8aa3b8, fog: true });
  for (let i = 0; i < 28; i++) {
    const ang = (i / 28) * Math.PI * 2;
    const r = 920 + (i % 5) * 40;
    const h = 70 + (i * 41) % 110;
    const geo = new THREE.ConeGeometry(80 + (i % 7) * 16, h, 5);
    const m = new THREE.Mesh(geo, peakMat);
    m.position.set(Math.cos(ang) * r, h * 0.22, Math.sin(ang) * r);
    m.rotation.y = ang;
    peakGroup.add(m);
  }
  scene.add(peakGroup);

  const hemi = new THREE.HemisphereLight(0xd8ead8, 0x3a4a28, 0.62);
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
    },
    dispose() {
      sky.removeFromParent();
      peakGroup.removeFromParent();
      hemi.removeFromParent();
      amb.removeFromParent();
      sun.removeFromParent();
      fill.removeFromParent();
      skyGeo.dispose();
      skyMat.dispose();
      peakMat.dispose();
    },
  };
}

export function applyCarEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x8aab9a);

  const envSkyGeo = new THREE.SphereGeometry(8, 16, 10);
  const envSkyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x6a9aae) },
      uHorizon: { value: new THREE.Color(0xb8cfc0) },
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
