import { AUDIO } from '../config';
import { VEHICLE_AUDIO, scrapeKeyFor } from './config';
import type { AudioGraph } from './graph';
import type { SampleBank } from './samples';
import { LoopVoice, playOneShot, playOneShotAt } from './voices';
import { pickVariationIndex, pitchJitter, volumeJitter, startOffset } from './variation';
import type { CollisionMaterial, Vec3 } from './types';
import type { ChassisContact } from '../physics/contacts';
import type { WheelVisual } from '../physics/vehicle';

export class BodyAudio {
  private scrape: LoopVoice;
  private scrapeKey = 'scrape.dirt';
  private lastImpactAt = 0;
  private lastSuspAt = [0, 0, 0, 0];
  private prevGrounded = [false, false, false, false];
  private lastPoolIndex = new Map<string, number>();
  scrapeLevel = 0;
  lastCollision = 0;
  lastSusp = 0;

  constructor(
    private graph: AudioGraph,
    private bank: SampleBank,
  ) {
    this.scrape = new LoopVoice(graph.ctx, graph.scrapePanner.input);
    this.scrape.setBuffer(bank.get('scrape.dirt'));
  }

  updateScrape(intensity: number, position: Vec3, material: CollisionMaterial, now: number): void {
    this.scrapeLevel = intensity;
    const key = scrapeKeyFor(material);
    if (key !== this.scrapeKey) {
      this.scrapeKey = key;
      this.scrape.setBuffer(this.bank.get(key));
    }
    this.graph.scrapePanner.setPosition(position, now);
    this.scrape.setGain(intensity * 0.48 * AUDIO.sfx, now, intensity > 0.05 ? 0.04 : 0.12);
    this.scrape.setRate(0.85 + intensity * 0.4, now, 0.08);
  }

  processContacts(contacts: ChassisContact[], now: number): number {
    let maxImpact = 0;
    let scrape = 0;
    let scrapePos: Vec3 | null = null;
    let scrapeMat: CollisionMaterial = 'rock';

    for (const c of contacts) {
      if (c.scrape > scrape) {
        scrape = c.scrape;
        scrapePos = c.position;
        scrapeMat = c.material;
      }
      const fire =
        c.intensity >= VEHICLE_AUDIO.impact.minIntensity &&
        (c.started || c.spiked);
      if (fire && now - this.lastImpactAt > VEHICLE_AUDIO.impact.cooldown) {
        this.playCollision(c);
        this.lastImpactAt = now;
        maxImpact = Math.max(maxImpact, c.intensity);
      }
    }

    this.updateScrape(
      scrape,
      scrapePos ?? { x: 0, y: 0, z: 0 },
      scrapeMat,
      now,
    );
    this.lastCollision = maxImpact;
    return maxImpact;
  }

  processSuspension(wheels: WheelVisual[], now: number): number {
    const cfg = VEHICLE_AUDIO.suspension;
    let peak = 0;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const was = this.prevGrounded[i];
      this.prevGrounded[i] = w.grounded;
      if (!w.grounded) continue;
      const landing = !was && w.compressionVel > cfg.velThreshold * 0.6;
      const bump =
        w.compressionVel > cfg.velThreshold &&
        w.compression > cfg.compressionThreshold;
      if (!landing && !bump) continue;
      if (now - (this.lastSuspAt[i] ?? 0) < cfg.cooldown) continue;

      let intensity = Math.min(1, w.compressionVel / 12) * (0.45 + w.compression * 0.55);
      if (landing) intensity = Math.min(1, intensity * cfg.landingBoost);
      if (intensity < 0.12) continue;

      this.lastSuspAt[i] = now;
      this.playSuspension(intensity, w.position);
      peak = Math.max(peak, intensity);
    }
    this.lastSusp = peak;
    return peak;
  }

  playCollision(c: ChassisContact): void {
    const pool = this.bank.impactPool(c.material);
    const last = this.lastPoolIndex.get(c.material) ?? -1;
    const idx = pickVariationIndex(pool.length, last);
    this.lastPoolIndex.set(c.material, idx);
    const buf = pool[idx];
    const panner = this.graph.nextImpactPanner();
    const g = (0.18 + c.intensity * 0.75) * volumeJitter(0.07) * AUDIO.sfx;
    playOneShotAt(this.graph.ctx, buf, panner, c.position, {
      gain: g,
      rate: pitchJitter(0.04),
      offset: startOffset(Math.min(0.04, buf.duration * 0.15)),
      duration: 0.12 + c.intensity * 0.28,
    });
    if (c.intensity > 0.28) {
      const crunch = this.bank.impactPool(
        c.material === 'wood' ? 'wood' : 'metal',
      );
      const b2 = crunch[pickVariationIndex(crunch.length, idx)];
      playOneShotAt(this.graph.ctx, b2, this.graph.nextImpactPanner(), c.position, {
        gain: g * 0.55,
        rate: pitchJitter(0.05) * 0.95,
        duration: 0.18 + c.intensity * 0.2,
      });
    }
    if (c.intensity > 0.62) {
      const debris = this.bank.get(
        c.material === 'glass' ? 'impact.glass.0' : 'impact.rock.1',
      );
      playOneShotAt(this.graph.ctx, debris, this.graph.nextImpactPanner(), c.position, {
        gain: g * 0.4,
        rate: pitchJitter(0.06),
        duration: 0.25,
      });
    }
  }

  playSuspension(intensity: number, position: Vec3): void {
    const key =
      intensity > 0.7 ? 'susp.large' : intensity > 0.38 ? 'susp.medium' : 'susp.small';
    playOneShotAt(
      this.graph.ctx,
      this.bank.get(key),
      this.graph.nextImpactPanner(),
      position,
      {
        gain: (0.2 + intensity * 0.55) * AUDIO.sfx,
        rate: pitchJitter(0.03),
        duration: 0.08 + intensity * 0.18,
      },
    );
  }

  playShift(): void {
    playOneShot(this.graph.ctx, this.bank.get('trans.shift'), this.graph.enginePanner.input, {
      gain: 0.42 * AUDIO.sfx,
      rate: pitchJitter(0.02),
      duration: 0.12,
    });
  }

  playGrind(): void {
    playOneShot(this.graph.ctx, this.bank.get('trans.grind'), this.graph.enginePanner.input, {
      gain: 0.4 * AUDIO.sfx,
      rate: pitchJitter(0.03),
      duration: 0.22,
    });
  }

  playStall(): void {
    playOneShot(this.graph.ctx, this.bank.get('impact.metal.0'), this.graph.enginePanner.input, {
      gain: 0.35 * AUDIO.sfx,
      rate: 0.7,
      duration: 0.4,
    });
  }
}
