import { AUDIO } from '../config';
import type { CollisionMaterial, EngineLayerId, SurfaceType } from './types';

export type SampleUrlMap = Record<string, string>;

export type VehicleAudioTuning = {
  samples: SampleUrlMap;
  spatial: {
    refDistance: number;
    maxDistance: number;
    rolloff: number;
  };
  engineOffset: { x: number; y: number; z: number };
  exhaustOffset: { x: number; y: number; z: number };
  interior: {
    cutoffHz: number;
    exteriorCutoffHz: number;
    cabinPeakHz: number;
    cabinPeakGainDb: number;
    engineInteriorScale: number;
  };
  impact: {
    minIntensity: number;
    cooldown: number;
    spikeDelta: number;
  };
  suspension: {
    velThreshold: number;
    compressionThreshold: number;
    landingBoost: number;
    cooldown: number;
  };
  scrape: {
    minSpeed: number;
    fadeRelease: number;
  };
};

const A = '/audio';

function impactPool(kind: CollisionMaterial, n = 5): SampleUrlMap {
  const out: SampleUrlMap = {};
  for (let i = 0; i < n; i++) {
    out[`impact.${kind}.${i}`] = `${A}/impact/${kind}_0${i + 1}.wav`;
  }
  return out;
}

const SURFACE_ROLL: Record<SurfaceType, string> = {
  tarmac: `${A}/tires/roll_tarmac.wav`,
  dirt: `${A}/tires/roll_dirt.wav`,
  gravel: `${A}/tires/roll_gravel.wav`,
  scree: `${A}/tires/roll_scree.wav`,
  grass: `${A}/tires/roll_grass.wav`,
  rock: `${A}/tires/roll_rock.wav`,
  mud: `${A}/tires/roll_mud.wav`,
  water: `${A}/tires/roll_water.wav`,
};

const ENGINE_URLS: Record<EngineLayerId | 'intake' | 'exhaust' | 'starter', string> = {
  idle: `${A}/engine/idle.wav`,
  low: `${A}/engine/low.wav`,
  mid: `${A}/engine/mid.wav`,
  high: `${A}/engine/high.wav`,
  redline: `${A}/engine/redline.wav`,
  intake: `${A}/engine/intake.wav`,
  exhaust: `${A}/engine/exhaust.wav`,
  starter: `${A}/engine/starter.wav`,
};

export const VEHICLE_AUDIO: VehicleAudioTuning = {
  samples: {
    ...Object.fromEntries(
      (Object.keys(ENGINE_URLS) as (keyof typeof ENGINE_URLS)[]).map((k) => [
        `engine.${k}`,
        ENGINE_URLS[k],
      ]),
    ),
    ...Object.fromEntries(
      (Object.keys(SURFACE_ROLL) as SurfaceType[]).map((s) => [
        `tire.roll.${s}`,
        SURFACE_ROLL[s],
      ]),
    ),
    'tire.skid.squeal': `${A}/tires/skid_squeal.wav`,
    'tire.skid.grit': `${A}/tires/skid_grit.wav`,
    'brake.mechanical': `${A}/brakes/mechanical.wav`,
    'trans.shift': `${A}/trans/shift.wav`,
    'trans.grind': `${A}/trans/grind.wav`,
    'susp.small': `${A}/suspension/small.wav`,
    'susp.medium': `${A}/suspension/medium.wav`,
    'susp.large': `${A}/suspension/large.wav`,
    'scrape.metal': `${A}/scrape/metal.wav`,
    'scrape.rock': `${A}/scrape/rock.wav`,
    'scrape.dirt': `${A}/scrape/dirt.wav`,
    ...impactPool('metal'),
    ...impactPool('wood'),
    ...impactPool('rock'),
    ...impactPool('dirt'),
    ...impactPool('vehicle'),
    ...impactPool('concrete'),
    ...impactPool('glass'),
    ...impactPool('water'),
    ...impactPool('grass'),
  },
  spatial: {
    refDistance: AUDIO.spatial?.refDistance ?? 8,
    maxDistance: AUDIO.spatial?.maxDistance ?? 80,
    rolloff: AUDIO.spatial?.rolloff ?? 1,
  },
  engineOffset: AUDIO.engineOffset ?? { x: 0, y: 0.22, z: -1.15 },
  exhaustOffset: AUDIO.exhaustOffset ?? { x: 0.38, y: 0.08, z: 1.75 },
  interior: {
    cutoffHz: 1280,
    exteriorCutoffHz: 14000,
    cabinPeakHz: 175,
    cabinPeakGainDb: 4.5,
    engineInteriorScale: 0.72,
  },
  impact: {
    minIntensity: 0.08,
    cooldown: 0.085,
    spikeDelta: 0.25,
  },
  suspension: {
    velThreshold: 2.4,
    compressionThreshold: 0.42,
    landingBoost: 1.55,
    cooldown: 0.18,
  },
  scrape: {
    minSpeed: 1.2,
    fadeRelease: 3.2,
  },
};

export function scrapeKeyFor(material: string): 'scrape.metal' | 'scrape.rock' | 'scrape.dirt' {
  if (material === 'metal' || material === 'vehicle' || material === 'glass') {
    return 'scrape.metal';
  }
  if (material === 'rock' || material === 'concrete') return 'scrape.rock';
  return 'scrape.dirt';
}
