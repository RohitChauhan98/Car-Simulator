/** Back-compat: vehicle audio now lives on VehicleAudioController. */
export {
  VehicleAudioController as AudioEngine,
  VehicleAudioController as EngineSound,
} from './controller';
export type { VehicleAudioFrame } from './controller';
