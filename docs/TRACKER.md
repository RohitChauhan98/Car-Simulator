# Himalayan Drive — cross-system tracker

Living matrix. Any world/vehicle visual change must add or update a row here (see `.cursor/rules/cross-system-tracker.mdc`).

| Feature | Visual | Physics | Audio | VFX | HUD / other | Status |
|---|---|---|---|---|---|---|
| Dirt trail | `src/world/trail.ts` kind `dirt`, splat id 1 | terrain trimesh + `SURFACES[1]` | `tire.roll.dirt` | dust (`dust: 0.7`) | n/a | shipped |
| Gravel / steep / narrow | `trail.ts` kinds `steep`/`narrow`, splat id 2, gravel albedo mix | `SURFACES[2]` | `tire.roll.gravel` (placeholder until WAV) | grey-tan dust | n/a | shipped |
| Scree | splat id 3 | `SURFACES[3]` | `tire.roll.scree` | high dust | n/a | shipped |
| Grass off-trail | splat id 4 | `SURFACES[4]` | `tire.roll.grass` | light dust | n/a | shipped |
| Rock surface | splat id 5, rocky trail sections | `SURFACES[5]` + rock balls | `tire.roll.rock`, `scrape.rock`, `impact.rock.*` | n/a | n/a | shipped |
| Mud section | `trail.ts` kind `mud` (~t 0.88), dark splat + ruts | `SURFACES[6]` | `tire.roll.mud` (placeholder until WAV) | dark brown dust | n/a | shipped |
| Early creek + main water | `src/world/water.ts` (t ~0.18 and ~0.48), splat id 7 | hydro drag, `SURFACES[7]` | `tire.roll.water`, `impact.water.*`, louder river ambience | water spray | n/a | shipped |
| On-path stones | `obstacles.ts` small/medium on driving line | Rapier balls for every rock (`colliderRockCount` = `rockCount`) | `tire.roll.rock`, `impact.rock.*` | n/a | n/a | shipped |
| Roadside boulders | `obstacles.ts` large beside trail | Rapier balls sized from instance scale | `scrape.rock`, `impact.rock.*` | n/a | camera occlusion | shipped |
| Pebbles | instanced scatter | visual-only (too small) | n/a | n/a | n/a | shipped |
| Fallen logs | `obstacles.ts` cylinders | capsules, material `wood` | `impact.wood.*` | n/a | n/a | shipped |
| Forest corridor | `vegetation.ts` tall pines on trail edge | near-trail trunk capsules, `wood` | denser wind ambience | n/a | occlusion hash, fog 52/220 | shipped |
| Undergrowth | bushes + ferns on shoulder | n/a (no colliders) | n/a | n/a | n/a | shipped |
| Dedicated tires | `src/world/tires.ts` + `carMesh.ts` (FBX wheels hidden) | posed from raycast `WheelVisual` | tire roll/skid (existing) | n/a | n/a | shipped |
| Body materials | glass / paint / metal / lights split | n/a | n/a | n/a | n/a | shipped |
| Chase camera | closer chase (`distance` 9.2, `height` 2.55), min pull 4.2 m so trees/rocks do not shove the camera into the cabin | n/a | interior vs exterior (hood) | n/a | n/a | shipped |
| Engine / trans | n/a | powertrain snapshot | `engine.*`, `trans.*` | n/a | HUD RPM | shipped |
| Suspension articulation | tires follow `worldPos` | springs + bump (physics plan) | `susp.small/medium/large` | n/a | n/a | sibling plan |
| Chassis belly clearance | n/a | cuboid offset (physics plan) | scrape/impact | n/a | debug overlay | sibling plan |

## Audio sample keys still needing real WAVs

Trail look made these **first-class in the opening minutes**. Mixer already has procedural placeholders (`src/audio/config.ts` / `public/audio/README.txt`):

- `tires/roll_dirt.wav` `roll_gravel.wav` `roll_mud.wav` `roll_water.wav` `roll_rock.wav`
- `impact/water_01.wav` … `water_05.wav`
- `scrape/rock.wav` `impact/rock_01.wav` …
- Ambience is procedural wind + river in `src/audio/ambience.ts` (boosted with this pass)

Drop files on those paths; no code change needed.
