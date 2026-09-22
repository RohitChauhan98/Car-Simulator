import type { AudioDebugSnapshot } from './types';

/** On-screen meters for vehicle audio. Off unless `?audioDebug` or AUDIO.debug. */
export class AudioDebugOverlay {
  private root: HTMLPreElement;
  visible: boolean;

  constructor(visible: boolean) {
    this.visible = visible;
    this.root = document.createElement('pre');
    this.root.className = 'audio-debug';
    this.root.style.display = visible ? 'block' : 'none';
    document.getElementById('hud')?.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? 'block' : 'none';
  }

  update(snap: AudioDebugSnapshot | null): void {
    if (!this.visible) return;
    if (!snap) {
      this.root.textContent = 'audio: not started';
      return;
    }
    const p = snap.params;
    const bar = (v: number, w = 10) => {
      const n = Math.max(0, Math.min(w, Math.round(v * w)));
      return '#'.repeat(n) + '-'.repeat(w - n);
    };
    const layerLines = Object.entries(snap.layers)
      .map(([k, v]) => `  ${k.padEnd(8)} ${bar(v)} ${v.toFixed(2)}`)
      .join('\n');
    this.root.textContent =
      `VEHICLE AUDIO  cam:${snap.interior ? 'interior' : 'exterior'}\n` +
      `state ${p.engineState}  RPM ${p.rpm.toFixed(0).padStart(5)}  thr ${p.throttle.toFixed(2)}  ` +
      `spd ${p.speed.toFixed(1)} m/s\n` +
      `brake ${p.brake.toFixed(2)}  gear ${p.gear}  load ${p.engineLoad.toFixed(2)} (${p.loadMode})\n` +
      `slip ${p.wheelSlip.toFixed(2)}  long ${p.longitudinalSlip.toFixed(2)}  lat ${p.lateralSlip.toFixed(2)}\n` +
      `surface ${p.surfaceType}  grounded ${p.isGrounded ? 'yes' : 'no'}\n` +
      `collision ${p.collisionImpact.toFixed(2)}  scrape ${p.scrapeIntensity.toFixed(2)}  ` +
      `susp ${p.suspensionImpact.toFixed(2)}\n` +
      `layers\n${layerLines}`;
  }
}

export function wantAudioDebug(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('audioDebug')) return true;
  } catch { /* no window */ }
  return false;
}
