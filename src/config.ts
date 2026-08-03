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
  spawn: { x: -500, z: 428 },       // valley floor road start (y from terrain)
};

export const SUSPENSION = {
  restLength: 0.42,     // m
  maxTravel: 0.26,      // m of compression from rest
  stiffness: 26000,     // N/m per wheel
  damperCompression: 3400,  // N s/m
  damperRebound: 3900,
  antiRoll: 6500,       // N/m of compression difference across an axle
  wheelRadius: 0.34,
  wheelInertia: 1.4,    // kg m^2
  // wheel attach points in chassis space (forward = -Z, up = +Y)
  attach: {
    frontZ: -1.32,
    rearZ: 1.28,
    halfTrack: 0.78,
    y: -0.15,
  },
};

export const TIRES = {
  // simplified Pacejka: F = D * sin(C * atan(B * slip))
  longB: 11.0,
  longC: 1.85,
  latB: 8.0,
  latC: 1.5,
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
  1: { name: 'dirt',   grip: 0.72, rolling: 1.5, roughness: 0.35, dust: 0.7 },
  2: { name: 'gravel', grip: 0.58, rolling: 1.8, roughness: 0.55, dust: 1.0 },
  3: { name: 'scree',  grip: 0.40, rolling: 2.4, roughness: 0.9,  dust: 1.0 },
  4: { name: 'grass',  grip: 0.60, rolling: 2.0, roughness: 0.45, dust: 0.4 },
  5: { name: 'rock',   grip: 0.85, rolling: 1.4, roughness: 0.75, dust: 0.3 },
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
  idleThrottleMax: 0.32,  // how much throttle the idle controller may add
  idleControlBand: 320,   // rpm band for idle controller
  crankTime: 0.85,        // seconds of starter motor
  crankRPM: 320,
  coldStartDuration: 6,   // idle wobble after first start, seconds
};

export const TRANSMISSION = {
  // Taller numerical 1st (~4.05) for hill starts; keep upper gears usable
  gearRatios: [4.05, 2.15, 1.42, 1.05, 0.82], // 1..5
  reverseRatio: 3.9,
  finalDrive: 4.30,
  efficiency: 0.9,
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
  size: 1100,             // meters, square
  gridN: 384,             // heightmap resolution (gridN+1 vertices per side)
  valleyLineZ: 430,       // z of the valley floor line
  riverZ: 468,
  riverHalfWidth: 11,
  treeCount: 2600,
  rockCount: 900,
  colliderRockCount: 110,
  pebbleCount: 56,
  fogNear: 180,
  fogFar: 1600,
};

export const CAMERA = {
  fov: 62,
  chaseDistance: 7.2,
  chaseHeight: 2.6,
  chaseStiffness: 4.2,
  lookAhead: 4.0,
  hoodOffset: { x: -0.36, y: 0.62, z: -0.1 }, // driver eye point in chassis space
  cinematicRadius: 26,
};

export const AUDIO = {
  master: 0.7,
  engine: 0.5,
  sfx: 0.6,
  ambience: 0.35,
  cylinders: 4,
};
