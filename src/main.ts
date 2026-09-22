import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS, CAMERA, VEHICLES, DEFAULT_VEHICLE_ID, AUDIO, type VehicleSpec } from './config';
import { GameLoop } from './core/loop';
import { Input } from './input/input';
import { Vehicle } from './physics/vehicle';
import { ChassisContactProbe } from './physics/contacts';
import { createWorld } from './world/terrain';
import { CarMesh } from './world/carMesh';
import { VehicleAudioController } from './audio/controller';
import { AudioDebugOverlay, wantAudioDebug } from './audio/debug';
import { CameraController } from './camera/cameras';
import { Hud } from './ui/hud';
import { bindGarage } from './ui/garage';

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
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    2800,
  );

  const physics = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
  physics.timestep = PHYSICS.dt;

  const world = await createWorld(scene, physics, renderer);
  const spawn = world.getSpawnPose();
  const spawnPos = { x: spawn.x, y: spawn.y, z: spawn.z };
  const spawnYaw = spawn.yaw;

  let spec = VEHICLES.find((v) => v.id === DEFAULT_VEHICLE_ID) ?? VEHICLES[0];
  let vehicle: Vehicle | null = null;
  let carMesh: CarMesh | null = null;
  let driving = false;
  let swapping = false;

  const input = new Input();
  input.bindLook(canvas);
  const hud = new Hud(hudRoot);
  const cams = new CameraController(camera);
  cams.setOccluders(world.occluders);
  cams.setHeightAt((x, z) => world.heightAt(x, z));

  async function spawnVehicle(next: VehicleSpec) {
    swapping = true;
    try {
      const mesh = await CarMesh.create(next, scene);
      const v = new Vehicle(physics, spawnPos, next);
      const halfYaw = spawnYaw * 0.5;
      v.body.setRotation(
        { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) },
        true,
      );
      v.syncPose(true);
      v.setGetSurface((x, z) => world.surfaceAt(x, z));
      v.setWaterHeightAt((x, z) => world.waterHeightAt(x, z));
      cams.setHoodOffset(next.hoodOffset);

      carMesh?.dispose();
      vehicle?.dispose(physics);
      carMesh = mesh;
      vehicle = v;
      spec = next;
    } finally {
      swapping = false;
    }
  }

  await spawnVehicle(spec);

  const vehicleAudio = new VehicleAudioController();
  const contactProbe = new ChassisContactProbe();
  const audioDebug = new AudioDebugOverlay(AUDIO.debug || wantAudioDebug());
  const listenerPos = new THREE.Vector3();
  const listenerFwd = new THREE.Vector3();
  const listenerUp = new THREE.Vector3();

  let qualityScale = 1;
  let frameTimeEma = 1 / 60;
  let frameCount = 0;
  let smokeLogged = false;
  let lastBottomOutAt = 0;
  const smoke = new URLSearchParams(location.search).has('smoke');
  const smokeStart = performance.now();
  const carPos = new THREE.Vector3();

  const idleControls = {
    throttle: 0,
    brake: 0,
    clutch: 1,
    steer: 0,
    handbrake: true,
  };

  const loop = new GameLoop({
    fixedUpdate(dt) {
      if (!vehicle || swapping) return;
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
      if (driving) vehicle.handleActions(actions, clutch);

      vehicle.step(physics, dt, driving
        ? {
          throttle: input.throttle,
          brake: input.brake,
          clutch,
          steer: input.steer,
          handbrake: input.handbrake,
        }
        : idleControls);
      physics.step();
      vehicle.maybeRespawn((x, z) => world.heightAt(x, z));

      const events = vehicle.consumeEvents();
      vehicleAudio.pushEvents(events);
      for (const ev of events) {
        if (ev.type === 'stall') {
          cams.addShake(0.9);
          hud.toast('Stalled — hold clutch + R to restart');
        } else if (ev.type === 'grind') {
          hud.toast('Clutch in to shift');
        } else if (ev.type === 'ignitionDenied') {
          hud.toast('Hold clutch or select N, then R to start');
        } else if (ev.type === 'shift' && ev.ok && ev.gear === -1) {
          hud.toast('Reverse — W to go back, S still brakes');
        }
      }

      vehicleAudio.pushContacts(
        contactProbe.poll(physics, vehicle.chassisCollider, vehicle.body, vehicle.spec.mass),
      );

      const now = performance.now() / 1000;
      for (const w of vehicle.wheels) {
        if (w.grounded && w.compression > 0.92 && now - lastBottomOutAt > 0.25) {
          lastBottomOutAt = now;
          cams.addShake(0.35);
          break;
        }
      }
    },

    render(alpha, frameDt) {
      if (!vehicle || !carMesh) return;
      frameCount++;
      frameTimeEma = frameTimeEma * 0.9 + frameDt * 0.1;

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

      carMesh.setInteriorVisible(cams.mode === 'hood');
      carMesh.update(
        interp.position,
        interp.rotation,
        wheels,
        driving ? input.brake : 0,
        vehicle.getSteerAngle(),
      );

      carPos.set(interp.position.x, interp.position.y, interp.position.z);
      world.step(frameDt, carPos);
      world.updateParticles(wheels, { x: snap.linearVel.x, z: snap.linearVel.z }, frameDt);

      const look = input.consumeLook();
      cams.applyLook(look.dx, look.dy, look.zoom);
      cams.update(
        frameDt,
        {
          position: interp.position,
          rotation: interp.rotation,
          rpm: snap.rpm,
          engineRunning: snap.engineState === 'running' || snap.engineState === 'cranking',
          linearVel: snap.linearVel,
        },
        physics,
        vehicle.body,
      );

      camera.getWorldPosition(listenerPos);
      camera.getWorldDirection(listenerFwd);
      listenerUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      vehicleAudio.update({
        snapshot: snap,
        throttle: driving ? input.throttle : 0,
        brake: driving ? input.brake : 0,
        clutch,
        cameraMode: cams.mode,
        listenerPos,
        listenerForward: listenerFwd,
        listenerUp,
        distToWater: world.distanceToWater(interp.position.x, interp.position.z),
        dt: frameDt,
        wheelRadius: vehicle.spec.wheelRadius,
      });
      audioDebug.update(vehicleAudio.debugSnapshot());

      const surfaceId = wheels.find((w) => w.grounded)?.surfaceId ?? 0;
      hud.update({
        rpm: snap.rpm,
        speedMs: snap.speedMs,
        gearLabel: snap.gearLabel,
        throttle: driving ? input.throttle : 0,
        brake: driving ? input.brake : 0,
        clutch,
        steer: driving ? input.steer : 0,
        stalled: snap.stalled,
        handbrake: driving ? input.handbrake : true,
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

  const garage = bindGarage(startOverlay, async (next) => {
    if (driving || next.id === spec.id) return;
    try {
      await spawnVehicle(next);
    } catch (err) {
      console.error('Vehicle swap failed', err);
      garage.setSelected(spec.id);
      hud.toast('Could not load vehicle');
    }
  });

  startBtn.addEventListener('click', async () => {
    startOverlay.classList.add('hidden');
    driving = true;
    input.setLookEnabled(true);
    canvas.requestPointerLock().catch(() => {});
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      await vehicleAudio.start(ctx);
    } catch (err) {
      console.error('[audio] failed to start', err);
      hud.toast('Audio failed to start — check the console');
    }

    if (vehicle) {
      vehicle.powertrain.gear = 0;
      vehicle.powertrain.tryIgnition(1);
    }
    hud.toast('Click to look — clutch + gears to drive');
  });

  loop.start();
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('start-overlay');
  if (el) el.innerHTML = `<div class="start-card"><h1>Error</h1><p>${String(err)}</p></div>`;
});
