/**
 * Central tuning file. Every parameter that affects driving feel lives here
 * so the simulation can be iterated on quickly.
 */

export const PHYSICS = {
  dt: 1 / 120,          // fixed physics timestep
  maxStepsPerFrame: 5,
  gravity: -9.81,
  engineSubsteps: 8,    // engine/clutch ODE sub-integration inside a physics step
};

export const CHASSIS = {
  mass: 1350,                       // kg
  halfExtents: { x: 0.88, y: 0.55, z: 2.05 },  // collider half sizes (width, height, length)
  comOffset: { x: 0, y: -0.35, z: 0.05 },      // lowered center of mass
  inertia: { x: 2400, y: 2550, z: 620 },       // principal angular inertia
  dragCoef: 0.42,                   // 0.5 * rho * Cd * A  (F = dragCoef * v^2)
  rollingResistance: 210,           // N, applied when rolling
  spawn: { x: -480, z: -20 },       // jungle trail start (y from terrain)
};

/** Nominal wheel radius; per-car radius lives on VehicleSpec. */
export const SUSPENSION = {
  restLength: 0.42,     // m
  maxTravel: 0.26,      // m of compression from rest
  stiffness: 26000,     // N/m per wheel
  damperCompression: 3400,  // N s/m
  damperRebound: 3900,
  antiRoll: 6500,       // N/m of compression difference across an axle
  wheelRadius: 0.48,
  wheelInertia: 1.4,    // kg m^2
  // wheel attach points in chassis space (forward = -Z, up = +Y)
  attach: {
    frontZ: -1.60,
    rearZ: 1.62,
    halfTrack: 0.85,
    y: -0.67,
  },
};

export type VehicleId = 'offroad1' | 'offroad2' | 'offroad3';

export type VehicleSpec = {
  id: VehicleId;
  name: string;
  blurb: string;
  /** FBX body URL (skinned mesh with wheel bones). */
  bodyUrl: string;
  /** Diffuse / base-color texture for this body. */
  albedoUrl: string;
  /** Uniform model scale (FBX is authored in centimeters). */
  scale: number;
  rootYaw: number;
  bodyOffset: { x: number; y: number; z: number };
  mass: number;
  halfExtents: { x: number; y: number; z: number };
  comOffset: { x: number; y: number; z: number };
  inertia: { x: number; y: number; z: number };
  dragCoef: number;
  rollingResistance: number;
  wheelRadius: number;
  wheelInertia: number;
  attach: { frontZ: number; rearZ: number; halfTrack: number; y: number };
  hoodOffset: { x: number; y: number; z: number };
};

/**
 * UploadOffroadVehicles pack — OFFroad_01/02/03.
 * FBX units are cm; scale 0.01 → meters. Model +Z is forward; rootYaw π → sim -Z.
 */
export const VEHICLES: VehicleSpec[] = [
  {
    id: 'offroad1',
    name: 'Trail SUV',
    blurb: 'Tall wagon for mountain climbs',
    bodyUrl: '/vehicles/OFFroad_01.fbx',
    albedoUrl: '/vehicles/Textures/01_Texture.png',
    scale: 0.01,
    rootYaw: Math.PI,
    bodyOffset: { x: 0, y: -1.14, z: 0.16 },
    mass: 1720,
    halfExtents: { x: 1.05, y: 0.72, z: 2.15 },
    comOffset: { x: 0, y: -0.32, z: 0.05 },
    inertia: { x: 3100, y: 3300, z: 820 },
    dragCoef: 0.52,
    rollingResistance: 240,
    wheelRadius: 0.48,
    wheelInertia: 1.8,
    attach: { frontZ: -1.60, rearZ: 1.62, halfTrack: 0.845, y: -0.673 },
    hoodOffset: { x: -0.4, y: 0.55, z: -0.35 },
  },
  {
    id: 'offroad2',
    name: 'Ridge Runner',
    blurb: 'Compact off-roader',
    bodyUrl: '/vehicles/OFFroad_02.fbx',
    albedoUrl: '/vehicles/Textures/02_Texture.png',
    scale: 0.01,
    rootYaw: Math.PI,
    bodyOffset: { x: 0, y: -1.04, z: 0.16 },
    mass: 1580,
    halfExtents: { x: 0.95, y: 0.68, z: 2.0 },
    comOffset: { x: 0, y: -0.3, z: 0.04 },
    inertia: { x: 2800, y: 3000, z: 740 },
    dragCoef: 0.48,
    rollingResistance: 225,
    wheelRadius: 0.46,
    wheelInertia: 1.65,
    attach: { frontZ: -1.48, rearZ: 1.38, halfTrack: 0.80, y: -0.593 },
    hoodOffset: { x: -0.38, y: 0.5, z: -0.3 },
  },
  {
    id: 'offroad3',
    name: 'Summit Pickup',
    blurb: 'Long-wheelbase trail truck',
    bodyUrl: '/vehicles/OFFroad_03.fbx',
    albedoUrl: '/vehicles/Textures/03_Texture.png',
    scale: 0.01,
    rootYaw: Math.PI,
    bodyOffset: { x: 0, y: -1.03, z: 0.14 },
    mass: 1680,
    halfExtents: { x: 0.95, y: 0.7, z: 2.3 },
    comOffset: { x: 0, y: -0.3, z: 0.06 },
    inertia: { x: 3000, y: 3200, z: 800 },
    dragCoef: 0.5,
    rollingResistance: 235,
    wheelRadius: 0.47,
    wheelInertia: 1.75,
    attach: { frontZ: -1.70, rearZ: 1.66, halfTrack: 0.81, y: -0.58 },
    hoodOffset: { x: -0.38, y: 0.52, z: -0.28 },
  },
];

export const DEFAULT_VEHICLE_ID: VehicleId = 'offroad1';

export function getVehicleSpec(id: string | null | undefined): VehicleSpec {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}

export const TIRES = {
  // simplified Pacejka: F = D * sin(C * atan(B * slip))
  // longC kept near 1.4 so high slip doesn't crater Fx (C≈1.85 fell to ~27% of peak
  // under 1st-gear wheelspin — high RPM, no climb).
  longB: 10.0,
  longC: 1.35,
  latB: 8.0,
  latC: 1.45,
  // Clamp |slip| fed into longitudinal Pacejka so excess wheelspin still pushes
  // near peak μ instead of riding the falling flank. Real slip still drives FX/UI.
  longSlipForceCap: 0.22,
  loadSensitivity: 0.000018, // grip falls slightly with load
  slipDenomFloor: 3.0,       // m/s floor for slip-ratio denominator (low-speed stability)
  lowSpeedBlend: 2.5,        // m/s below which viscous tire model blends in
  rollInfluence: 0.55,       // raise lateral force application point (anti-flip)
};

/** Grip and feel per surface type. Ids are baked into the terrain surface map. */
export const SURFACES: Record<
  number,
  { name: string; grip: number; rolling: number; roughness: number; dust: number }
> = {
  0: { name: 'tarmac', grip: 1.12, rolling: 1.0, roughness: 0.0, dust: 0.05 },
  1: { name: 'dirt',   grip: 0.82, rolling: 1.5, roughness: 0.35, dust: 0.7 },
  2: { name: 'gravel', grip: 0.68, rolling: 1.8, roughness: 0.55, dust: 1.15 },
  3: { name: 'scree',  grip: 0.48, rolling: 2.4, roughness: 0.9,  dust: 1.0 },
  4: { name: 'grass',  grip: 0.68, rolling: 2.0, roughness: 0.45, dust: 0.4 },
  5: { name: 'rock',   grip: 0.90, rolling: 1.4, roughness: 0.75, dust: 0.3 },
  6: { name: 'mud',    grip: 0.42, rolling: 3.4, roughness: 0.55, dust: 0.35 },
  7: { name: 'water',  grip: 0.28, rolling: 4.2, roughness: 0.2,  dust: 0.0 },
};

export const ENGINE = {
  idleRPM: 900,
  stallRPM: 440,
  redlineRPM: 6800,
  limiterResumeRPM: 6500,
  maxRPM: 7400,
  inertia: 0.19,          // kg m^2
  // torque curve control points [rpm, N m] at full throttle
  // Raised low/mid torque so 1st can climb ~8–12% grades at full throttle
  torqueCurve: [
    [600, 125], [1000, 165], [1600, 195], [2400, 215], [3400, 228],
    [4400, 218], [5200, 198], [6000, 175], [6600, 148], [7200, 112],
  ] as [number, number][],
  // Stronger pumping/friction drag → clearer engine braking when clutch locked
  dragTorque: (rpm: number) => 18 + rpm * 0.011, // friction+pumping losses, N m
  idleThrottleMax: 0.32,  // how much extra the idle P-term may add/subtract
  idleHoldThrottle: 0.2,  // feedforward fuel that holds ~idle against drag
  idleControlBand: 320,   // rpm band for idle controller
  crankTime: 1.25,        // seconds of starter motor before catch
  crankRPM: 340,
  coldStartDuration: 6,   // idle wobble after first start, seconds
};

export const TRANSMISSION = {
  // Taller numerical 1st (~4.05) for hill starts; keep upper gears usable
  gearRatios: [4.05, 2.15, 1.42, 1.05, 0.82], // 1..5
  reverseRatio: 3.9,
  finalDrive: 4.30,
  efficiency: 0.9,
  // Off-road pack: AWD so climbs still hook up when the rear unloads on grade.
  // 0 = FWD, 1 = RWD, 0.55 = 45/55 front/rear.
  driveBiasRear: 0.55,
  clutchMaxTorque: 420,   // N m — must exceed peak engine τ through bite
  clutchViscosity: 85,    // N m s/rad kinetic / slip coupling
  // Extra stiffness when nearly locked so small slip still transmits static-like torque
  // (pure viscous → 0 at matched speeds, which felt like free-wheeling in gear)
  clutchLockStiffness: 920, // N m s/rad blended in with engagement²
  clutchLockSlipRad: 4.5,   // rad/s below which lock blend is full
  // Soft hill-hold: only when clutch engaged + in gear + very low speed (see transmission.ts)
  hillHoldSpeedMs: 1.15,    // below this chassis speed, assist may apply
  hillHoldTorqueNm: 95,     // extra clutch-referred resistance opposing reverse creep
  shiftClutchThreshold: 0.45, // pedal must be pressed past this to shift
};

export const BRAKES = {
  maxTorque: 1900,        // N m per front wheel (rears get 60 %)
  rearBias: 0.6,
  handbrakeTorque: 2600,  // N m on rear wheels
  // fade model
  ambientTemp: 60,
  fadeStartTemp: 420,
  fadeEndTemp: 900,
  maxFade: 0.62,          // fraction of braking lost when fully faded
  heatRate: 0.00012,      // temp gain per joule-ish of brake work
  coolRate: 0.035,        // per second, scaled with speed
};

export const STEERING = {
  maxAngleLow: 0.58,      // rad at standstill
  maxAngleHigh: 0.09,     // rad at high speed
  speedForHigh: 38,       // m/s where high-speed limit is reached
  steerSpeed: 3.2,        // input ramp, per second
  returnSpeed: 4.5,
};

export const INPUT_RATES = {
  throttleAttack: 3.4, throttleRelease: 5.0,
  brakeAttack: 4.2, brakeRelease: 5.5,
  clutchAttack: 7.0,      // pressing the pedal is fast
  clutchRelease: 3.0,     // releasing takes ~0.33 s (dump it and you may stall)
  deadzone: 0.12,
};

export const WORLD = {
  size: 1100,
  gridN: 384,
  treeCount: 2000,
  bushCount: 1100,
  fernCount: 420,
  grassCount: 2600,
  grassRadius: 18,
  rockCount: 900,
  colliderRockCount: 900,
  logCount: 22,
  pebbleCount: 220,
  fogNear: 52,
  fogFar: 220,
};

export const CAMERA = {
  fov: 56,
  chaseDistance: 9.2,
  chaseHeight: 2.55,
  chaseStiffness: 5.4,
  lookAhead: 1.15,
  hoodOffset: { x: -0.36, y: 0.62, z: -0.1 },
  cinematicRadius: 26,
  mouseSensitivity: 0.00215,
  invertY: false,
  pitchMin: -0.22,
  pitchMax: 1.18,
  distanceMin: 4.4,
  distanceMax: 12,
  collisionSkin: 0.42,
  lookAtHeight: 1.05,
  chassisFollow: 0.22,
  accelResponse: 0.1,
  zoomSensitivity: 0.012,
};

export const AUDIO = {
  master: 0.7,
  engine: 0.72,
  sfx: 0.6,
  ambience: 0.35,
  cylinders: 4,
  /** Enable the on-screen audio meter overlay (also `?audioDebug`). */
  debug: false,
  spatial: {
    refDistance: 8,
    maxDistance: 80,
    rolloff: 1,
  },
  /** Chassis-space engine / exhaust anchors (forward = -Z). */
  engineOffset: { x: 0, y: 0.22, z: -1.15 },
  exhaustOffset: { x: 0.38, y: 0.08, z: 1.75 },
};
