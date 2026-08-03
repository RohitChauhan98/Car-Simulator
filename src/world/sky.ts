import * as THREE from 'three';
import { WORLD } from '../config';

export type SkySystem = {
  sun: THREE.DirectionalLight;
  update: (dt: number, carPos?: THREE.Vector3) => void;
  dispose: () => void;
};

/**
 * Gradient sky dome, sun+fill lights with shadows, fog, distant peak ring.
 */
export function createSky(scene: THREE.Scene): SkySystem {
  scene.fog = new THREE.Fog(0xb8c4ce, WORLD.fogNear, WORLD.fogFar);
  scene.background = new THREE.Color(0xa8b8c8);

  // Gradient dome
  const skyGeo = new THREE.SphereGeometry(2200, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x6a9cc8) },
      uHorizon: { value: new THREE.Color(0xd4c4a8) },
      uBottom: { value: new THREE.Color(0x8a9aaa) },
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
        vec3 col = mix(uBottom, uHorizon, smoothstep(-0.3, 0.05, h));
        col = mix(col, uTop, smoothstep(0.05, 0.7, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // Distant peak ring (silhouette mountains)
  const peakGroup = new THREE.Group();
  const peakMat = new THREE.MeshBasicMaterial({ color: 0x6a7380, fog: true });
  for (let i = 0; i < 36; i++) {
    const ang = (i / 36) * Math.PI * 2;
    const r = 900 + (i % 5) * 40;
    const h = 180 + (i * 47) % 220;
    const geo = new THREE.ConeGeometry(60 + (i % 7) * 15, h, 4);
    const m = new THREE.Mesh(geo, peakMat);
    m.position.set(Math.cos(ang) * r, h * 0.35, Math.sin(ang) * r);
    m.rotation.y = ang;
    peakGroup.add(m);
  }
  scene.add(peakGroup);

  const hemi = new THREE.HemisphereLight(0xc8d8e8, 0x5a4a38, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0d8, 1.35);
  sun.position.set(-400, 600, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 1400;
  sun.shadow.camera.left = -200;
  sun.shadow.camera.right = 200;
  sun.shadow.camera.top = 200;
  sun.shadow.camera.bottom = -200;
  sun.shadow.bias = -0.0003;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xa0b8d0, 0.25);
  fill.position.set(200, 100, -300);
  scene.add(fill);

  return {
    sun,
    update(_dt, carPos) {
      if (!carPos) return;
      sun.target.position.copy(carPos);
      sun.position.set(carPos.x - 400, carPos.y + 600, carPos.z + 200);
      sky.position.set(carPos.x, 0, carPos.z);
    },
    dispose() {
      sky.removeFromParent();
      peakGroup.removeFromParent();
      hemi.removeFromParent();
      sun.removeFromParent();
      fill.removeFromParent();
      skyGeo.dispose();
      skyMat.dispose();
      peakMat.dispose();
    },
  };
}
