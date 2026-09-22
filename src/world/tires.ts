import * as THREE from 'three';

const RADIAL = 32;

function makeTreadCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a1a1c';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#0e0e10';
  for (let y = 0; y < 256; y += 18) {
    g.fillRect(0, y, 256, 7);
  }
  g.fillStyle = '#2a2a2e';
  for (let x = 8; x < 256; x += 28) {
    for (let y = 2; y < 256; y += 18) {
      const stagger = ((y / 18) | 0) % 2 === 0 ? 0 : 10;
      g.fillRect(x + stagger, y, 12, 5);
    }
  }
  return c;
}

function makeSidewallCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const cx = 128;
  const cy = 128;
  const grd = g.createRadialGradient(cx, cy, 20, cx, cy, 128);
  grd.addColorStop(0, '#6a6a70');
  grd.addColorStop(0.38, '#3a3a40');
  grd.addColorStop(0.55, '#1c1c1e');
  grd.addColorStop(0.78, '#141416');
  grd.addColorStop(1, '#0c0c0e');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#4a4a50';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(cx, cy, 48, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = '#2e2e32';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(cx, cy, 96, 0, Math.PI * 2);
  g.stroke();
  return c;
}

function canvasMap(canvas: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export type TireVisual = {
  group: THREE.Group;
  dispose: () => void;
};

/**
 * Round off-road tire (tread cylinder + rubber/rim caps) posed in chassis space.
 */
export function createTireVisual(radius: number, width = 0.32): TireVisual {
  const group = new THREE.Group();
  const treadMap = canvasMap(makeTreadCanvas(), 6, 1);
  const sideMap = canvasMap(makeSidewallCanvas());

  const treadMat = new THREE.MeshStandardMaterial({
    map: treadMap,
    color: 0x2a2a2c,
    roughness: 0.92,
    metalness: 0.04,
    envMapIntensity: 0.22,
  });
  const sideMat = new THREE.MeshStandardMaterial({
    map: sideMap,
    color: 0x1a1a1c,
    roughness: 0.88,
    metalness: 0.08,
    envMapIntensity: 0.28,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x8a8a92,
    roughness: 0.35,
    metalness: 0.82,
    envMapIntensity: 1.15,
  });

  const tread = new THREE.CylinderGeometry(radius, radius, width, RADIAL, 4, true);
  tread.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tread, treadMat);
  tire.castShadow = true;
  tire.receiveShadow = true;
  tire.userData.owned = true;
  group.add(tire);

  const cap = new THREE.CircleGeometry(radius, RADIAL);
  const capL = new THREE.Mesh(cap, sideMat);
  capL.rotation.y = Math.PI / 2;
  capL.position.x = -width * 0.5;
  capL.castShadow = true;
  capL.userData.owned = true;
  const capR = capL.clone();
  capR.rotation.y = -Math.PI / 2;
  capR.position.x = width * 0.5;
  group.add(capL, capR);

  const rim = new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, width * 0.55, 16, 1);
  rim.rotateZ(Math.PI / 2);
  const rimMesh = new THREE.Mesh(rim, rimMat);
  rimMesh.castShadow = true;
  rimMesh.userData.owned = true;
  group.add(rimMesh);

  return {
    group,
    dispose() {
      tread.dispose();
      cap.dispose();
      rim.dispose();
      treadMat.dispose();
      sideMat.dispose();
      rimMat.dispose();
      treadMap.dispose();
      sideMap.dispose();
    },
  };
}
