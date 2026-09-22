import * as THREE from 'three';

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

export function makeCanvasTexture(
  size: number,
  paint: (ctx: CanvasRenderingContext2D, s: number) => void,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function speckled(ctx: CanvasRenderingContext2D, s: number, base: string, n: number, jitter: (g: number) => string) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = jitter(Math.random());
    ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 4, 1 + Math.random() * 4);
  }
}

export function proceduralDirt(): THREE.CanvasTexture {
  return makeCanvasTexture(512, (ctx, s) => {
    speckled(ctx, s, '#6d4e32', 2800, (g) => {
      const r = 90 + g * 70;
      return `rgba(${r | 0},${(60 + g * 50) | 0},${(30 + g * 28) | 0},${0.25 + g * 0.5})`;
    });
    for (let i = 0; i < 80; i++) {
      ctx.strokeStyle = `rgba(50,32,18,${0.08 + Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.moveTo(Math.random() * s, Math.random() * s);
      ctx.quadraticCurveTo(Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s);
      ctx.stroke();
    }
  });
}

export function proceduralGrass(): THREE.CanvasTexture {
  return makeCanvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#2f4a24';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 4200; i++) {
      ctx.strokeStyle = `rgba(${30 + Math.random() * 40},${80 + Math.random() * 90},${25 + Math.random() * 35},${0.35 + Math.random() * 0.4})`;
      const x = Math.random() * s;
      const y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 5, y - 4 - Math.random() * 8);
      ctx.stroke();
    }
  });
}

export function proceduralRock(): THREE.CanvasTexture {
  return makeCanvasTexture(512, (ctx, s) => {
    speckled(ctx, s, '#6a655c', 2200, (g) => {
      const v = 90 + g * 80;
      return `rgb(${v | 0},${(v - 8) | 0},${(v - 16) | 0})`;
    });
  });
}

export function proceduralMud(): THREE.CanvasTexture {
  return makeCanvasTexture(512, (ctx, s) => {
    speckled(ctx, s, '#3d2a1c', 1800, (g) => {
      const r = 45 + g * 50;
      return `rgba(${r | 0},${(28 + g * 30) | 0},${(14 + g * 16) | 0},${0.4 + g * 0.4})`;
    });
  });
}

export function proceduralBark(): THREE.CanvasTexture {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#4a3424';
    ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 3) {
      ctx.strokeStyle = `rgba(${40 + Math.random() * 40},${24 + Math.random() * 20},${12},${0.4})`;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + Math.sin(x * 0.2) * 4, s);
      ctx.stroke();
    }
  });
}

export function proceduralGrassCard(): THREE.CanvasTexture {
  return makeCanvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 42; i++) {
      const x = 8 + Math.random() * (s - 16);
      const w = 1.1 + Math.random() * 2.4;
      const h = 55 + Math.random() * 68;
      const g = 140 + Math.random() * 90;
      ctx.strokeStyle = `rgba(${70 + Math.random() * 50},${g | 0},${35 + Math.random() * 30},${0.7 + Math.random() * 0.3})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, s);
      ctx.quadraticCurveTo(
        x + (Math.random() - 0.5) * 14,
        s - h * 0.55,
        x + (Math.random() - 0.5) * 10,
        s - h,
      );
      ctx.stroke();
    }
  });
}

export function proceduralFernCard(): THREE.CanvasTexture {
  return makeCanvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const cx = s * 0.5;
    ctx.strokeStyle = 'rgba(36, 90, 40, 0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, s);
    ctx.quadraticCurveTo(cx + 8, s * 0.5, cx, 8);
    ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const t = 0.15 + i / 14;
      const y = s * (1 - t);
      const len = 18 + (1 - t) * 28;
      ctx.strokeStyle = `rgba(${30 + i * 2},${90 + i * 4},${35},${0.75})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.quadraticCurveTo(cx + len * 0.5, y - 6, cx + len, y + 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.quadraticCurveTo(cx - len * 0.5, y - 6, cx - len, y + 4);
      ctx.stroke();
    }
  });
}

export function proceduralLeaf(): THREE.CanvasTexture {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#1c4a28';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(${20 + Math.random() * 50},${70 + Math.random() * 90},${20 + Math.random() * 40},0.55)`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * s, Math.random() * s, 2 + Math.random() * 6, 1 + Math.random() * 3, Math.random(), 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

export function proceduralNormal(): THREE.CanvasTexture {
  return makeCanvasTexture(256, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = noise2(x * 0.08, y * 0.08);
        const i = (y * s + x) * 4;
        img.data[i] = 128 + (n - 0.5) * 80;
        img.data[i + 1] = 128 + (noise2(x * 0.08 + 40, y * 0.08) - 0.5) * 80;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, THREE.NoColorSpace);
}

export type EnvTextures = {
  dirt: THREE.Texture;
  grass: THREE.Texture;
  rock: THREE.Texture;
  mud: THREE.Texture;
  bark: THREE.Texture;
  leaf: THREE.Texture;
  dirtN: THREE.Texture;
  grassN: THREE.Texture;
  rockN: THREE.Texture;
  grassCard: THREE.Texture;
  fernCard: THREE.Texture;
};

const loader = new THREE.TextureLoader();

async function tryLoad(url: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture | null> {
  try {
    const tex = await loader.loadAsync(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = colorSpace;
    return tex;
  } catch {
    return null;
  }
}

/**
 * Load CC0 files from /env when present; otherwise high-quality procedural maps.
 * Drop albedo/normal JPGs into public/env/ to upgrade later without code changes.
 */
export async function loadEnvTextures(): Promise<EnvTextures> {
  const [
    dirt, grass, rock, mud, bark, leaf, dirtN, grassN, rockN,
  ] = await Promise.all([
    tryLoad('/env/dirt_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/grass_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/rock_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/mud_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/bark_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/leaf_diff.jpg', THREE.SRGBColorSpace),
    tryLoad('/env/dirt_nor.jpg', THREE.NoColorSpace),
    tryLoad('/env/grass_nor.jpg', THREE.NoColorSpace),
    tryLoad('/env/rock_nor.jpg', THREE.NoColorSpace),
  ]);

  const nFallback = proceduralNormal();
  return {
    dirt: dirt ?? proceduralDirt(),
    grass: grass ?? proceduralGrass(),
    rock: rock ?? proceduralRock(),
    mud: mud ?? proceduralMud(),
    bark: bark ?? proceduralBark(),
    leaf: leaf ?? proceduralLeaf(),
    dirtN: dirtN ?? nFallback,
    grassN: grassN ?? nFallback,
    rockN: rockN ?? nFallback,
    grassCard: clampCard(proceduralGrassCard()),
    fernCard: clampCard(proceduralFernCard()),
  };
}

function clampCard(tex: THREE.Texture) {
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export async function loadEnvMap(renderer: THREE.WebGLRenderer): Promise<THREE.Texture | null> {
  try {
    const { RGBELoader } = await import('three/addons/loaders/RGBELoader.js');
    const hdr = await new RGBELoader().loadAsync('/env/forest.hdr');
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    pmrem.dispose();
    return env;
  } catch {
    return null;
  }
}
