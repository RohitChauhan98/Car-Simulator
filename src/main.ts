import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS, WORLD, CAMERA } from './config';
import { GameLoop } from './core/loop';
import { Input } from './input/input';
import { Vehicle } from './physics/vehicle';
import { createWorld } from './world/terrain';
import { CarMesh } from './world/carMesh';
import { AudioEngine } from './audio/engineSound';
import { GameSFX } from './audio/sfx';
import { CameraController } from './camera/cameras';
import { Hud } from './ui/hud';

async function main() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud')!;
  const startOverlay = document.getElementById('start-overlay')!;
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;

  await RAPIER.init();

  let pixelRatio = Math.min(window.devicePixelRatio, 2);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    2800,
  );

  const physics = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
  physics.timestep = PHYSICS.dt;

  const world = createWorld(scene, physics);
  const spawn = world.getSpawnPose();

  const vehicle = new Vehicle(physics, { x: spawn.x, y: spawn.y, z: spawn.z });
  const halfYaw = spawn.yaw * 0.5;
  vehicle.body.setRotation(
    { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) },
    true,
  );
  vehicle.syncPose(true);
  vehicle.setGetSurface((x, z) => world.surfaceAt(x, z));

  const carMesh = new CarMesh(scene);
  const input = new Input();
  const hud = new Hud(hudRoot);
  const cams = new CameraController(camera);

  let engineSound: AudioEngine | null = null;
  let sfx: GameSFX | null = null;

  let qualityScale = 1;
  let frameTimeEma = 1 / 60;
  let frameCount = 0;
  let smokeLogged = false;
  let lastBottomOutAt = 0;
  const smoke = new URLSearchParams(location.search).has('smoke');
  const smokeStart = performance.now();
  const carPos = new THREE.Vector3();

  const loop = new GameLoop({
    fixedUpdate(dt) {
      input.update(dt);
      hud.tickClutchSpring(dt);
      const clutch = hud.isClutchSliderActive()
        ? hud.getClutchSlider()
        : Math.max(input.clutch, hud.getClutchSlider());
      const actions = input.consumeActions();
      for (const a of actions) {
        if (a === 'pause') {
          const paused = loop.togglePause();
          hud.setPaused(paused);
          continue;
        }
        if (a === 'camera') cams.cycle();
        if (a === 'toggleBars') hud.toggleBars();
      }
      vehicle.handleActions(actions, clutch);

      vehicle.step(physics, dt, {
        throttle: input.throttle,
        brake: input.brake,
        clutch,
        steer: input.steer,
        handbrake: input.handbrake,
      });
      physics.step();
      vehicle.maybeRespawn((x, z) => world.heightAt(x, z));

      const events = vehicle.consumeEvents();
      for (const ev of events) {
        if (ev.type === 'stall') {
          cams.addShake(0.9);
          sfx?.playStall();
          hud.toast('Stalled — hold clutch + R to restart');
        } else if (ev.type === 'shift' && ev.ok) {
          sfx?.playShift();
        } else if (ev.type === 'grind') {
          sfx?.playGrind();
          hud.toast('Clutch in to shift');
        } else if (ev.type === 'start') {
          sfx?.playStarter();
        }
      }

      // Bottom-out: hard suspension compression → thud + camera shake
      const now = performance.now() / 1000;
      for (const w of vehicle.wheels) {
        if (w.grounded && w.compression > 0.92 && now - lastBottomOutAt > 0.25) {
          lastBottomOutAt = now;
          sfx?.playThud();
          cams.addShake(0.35);
          break;
        }
      }
    },

    render(alpha, frameDt) {
      frameCount++;
      frameTimeEma = frameTimeEma * 0.9 + frameDt * 0.1;

      // Dynamic resolution: keep pixel ratio in [0.6, min(dpr, 2)]
      const targetMs = 1 / 55;
      if (frameTimeEma > targetMs && qualityScale > 0.6) {
        qualityScale = Math.max(0.6, qualityScale - 0.02);
        applyQuality();
      } else if (frameTimeEma < 1 / 58 && qualityScale < 1) {
        qualityScale = Math.min(1, qualityScale + 0.01);
        applyQuality();
      }

      const interp = vehicle.getInterpolated(alpha);
      const snap = vehicle.snapshot();
      const wheels = snap.wheels;
      const clutch = hud.isClutchSliderActive()
        ? hud.getClutchSlider()
        : Math.max(input.clutch, hud.getClutchSlider());

      carMesh.update(
        interp.position,
        interp.rotation,
        wheels,
        input.brake,
        vehicle.getSteerAngle(),
      );

      carPos.set(interp.position.x, interp.position.y, interp.position.z);
      world.step(frameDt, carPos);
      world.updateParticles(wheels, { x: snap.linearVel.x, z: snap.linearVel.z }, frameDt);

      cams.update(
        frameDt,
        {
          position: interp.position,
          rotation: interp.rotation,
          rpm: snap.rpm,
          engineRunning: snap.engineState === 'running' || snap.engineState === 'cranking',
        },
        physics,
        vehicle.body,
      );

      engineSound?.update(snap.rpm, snap.engineLoad, snap.engineState, snap.fuelCut);
      sfx?.update(
        wheels,
        snap.speedMs,
        snap.clutchSlip,
        clutch,
        Math.abs(interp.position.z - WORLD.riverZ),
      );

      const surfaceId = wheels.find((w) => w.grounded)?.surfaceId ?? 0;
      hud.update({
        rpm: snap.rpm,
        speedMs: snap.speedMs,
        gearLabel: snap.gearLabel,
        throttle: input.throttle,
        brake: input.brake,
        clutch,
        steer: input.steer,
        stalled: snap.stalled,
        handbrake: input.handbrake,
        fuelCut: snap.fuelCut,
        engineState: snap.engineState,
        brakeTemp: snap.brakeTemp,
        surface: surfaceId,
      });

      renderer.render(scene, camera);

      if (
        smoke &&
        !smokeLogged &&
        performance.now() - smokeStart > 3000 &&
        frameCount > 30
      ) {
        smokeLogged = true;
        console.log('SMOKE OK', snap.position, snap.rpm);
      }
    },
  });

  function applyQuality() {
    pixelRatio = Math.min(window.devicePixelRatio, 2) * qualityScale;
    pixelRatio = Math.max(0.6, Math.min(pixelRatio, Math.min(window.devicePixelRatio, 2)));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyQuality();
  });

  startBtn.addEventListener('click', async () => {
    startOverlay.classList.add('hidden');
    const ctx = new AudioContext();
    await ctx.resume();
    engineSound = new AudioEngine(ctx);
    sfx = new GameSFX(ctx);
    await engineSound.start(ctx);
    await sfx.start(ctx);

    // Cold-start in neutral so ignition works without clutch
    vehicle.powertrain.gear = 0;
    vehicle.powertrain.tryIgnition(1);
    loop.start();
    hud.toast('Engine starting — clutch + gears to drive');
  });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('start-overlay');
  if (el) el.innerHTML = `<div class="start-card"><h1>Error</h1><p>${String(err)}</p></div>`;
});
