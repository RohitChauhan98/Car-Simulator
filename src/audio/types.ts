/** Closed set matching `SURFACES[].name` in config. */
export type SurfaceType =
  | 'tarmac'
  | 'dirt'
  | 'gravel'
  | 'scree'
  | 'grass'
  | 'rock'
  | 'mud'
  | 'water';

export type CollisionMaterial =
  | 'metal'
  | 'concrete'
  | 'wood'
  | 'rock'
  | 'dirt'
  | 'grass'
  | 'glass'
  | 'water'
  | 'vehicle';

export type EngineLoadMode =
  | 'idle'
  | 'light'
  | 'medium'
  | 'full'
  | 'coast'
  | 'engineBrake';

export type EngineLayerId = 'idle' | 'low' | 'mid' | 'high' | 'redline';

export type Vec3 = { x: number; y: number; z: number };

export type VehicleAudioParams = {
  speed: number;
  normalizedSpeed: number;
  rpm: number;
  normalizedRPM: number;
  throttle: number;
  brake: number;
  gear: number;
  engineLoad: number;
  wheelSlip: number;
  averageWheelSlip: number;
  longitudinalSlip: number;
  lateralSlip: number;
  surfaceType: SurfaceType;
  suspensionImpact: number;
  collisionImpact: number;
  collisionDirection: Vec3;
  isGrounded: boolean;
  scrapeIntensity: number;
  loadMode: EngineLoadMode;
  engineState: string;
  fuelCut: boolean;
  clutchSlip: number;
  clutchPedal: number;
};

export type VehicleAudioEvent =
  | { type: 'gearShift'; gear: number; ok: boolean }
  | { type: 'grind' }
  | { type: 'stall' }
  | { type: 'start' }
  | { type: 'ignitionDenied' }
  | {
      type: 'suspensionImpact';
      intensity: number;
      position: Vec3;
    }
  | {
      type: 'collision';
      intensity: number;
      material: CollisionMaterial;
      position: Vec3;
      direction: Vec3;
    };

export type LayerLevels = Record<string, number>;

export type AudioDebugSnapshot = {
  params: VehicleAudioParams;
  layers: LayerLevels;
  interior: boolean;
};
