Vehicle audio samples
=====================

The sim synthesizes the engine with a 4-stroke combustion AudioWorklet
(starter motor, catch, stall sputter, exhaust pulses). Optional WAV files
below replace that voice when present. Missing files use generated placeholders
for tires/brakes/impacts so the mixer still works.

Drop your own WAV/OGG/MP3 files on these paths — no code changes needed.
Do not use copyrighted game rips (GTA, etc.).

Engine (looped, layered by RPM)
  engine/idle.wav
  engine/low.wav
  engine/mid.wav
  engine/high.wav
  engine/redline.wav
  engine/intake.wav          (optional)
  engine/exhaust.wav         (optional)
  engine/starter.wav         (optional)

Tires (looped)
  tires/roll_tarmac.wav
  tires/roll_dirt.wav
  tires/roll_gravel.wav
  tires/roll_scree.wav
  tires/roll_grass.wav
  tires/roll_rock.wav
  tires/roll_mud.wav
  tires/roll_water.wav
  tires/skid_squeal.wav      (asphalt)
  tires/skid_grit.wav        (off-road)

Brakes / transmission
  brakes/mechanical.wav      (loop)
  trans/shift.wav            (one-shot)
  trans/grind.wav            (one-shot)

Suspension (one-shots)
  suspension/small.wav
  suspension/medium.wav
  suspension/large.wav

Impacts — five variations per material (one-shots)
  impact/metal_01.wav … metal_05.wav
  impact/wood_01.wav … wood_05.wav
  impact/rock_01.wav … rock_05.wav
  impact/dirt_01.wav … dirt_05.wav
  impact/vehicle_01.wav … vehicle_05.wav
  impact/concrete_01.wav … concrete_05.wav
  impact/glass_01.wav … glass_05.wav
  impact/water_01.wav … water_05.wav
  impact/grass_01.wav … grass_05.wav

Scraping (looped)
  scrape/metal.wav
  scrape/rock.wav
  scrape/dirt.wav

Debug: open the game with ?audioDebug to show live layer meters.

Trail look (2026-09-17): dirt, gravel, mud, water, and rock are audible from spawn
onward. Until real files exist, SampleBank keeps generating placeholders. Priority
drops: tires/roll_{dirt,gravel,mud,water,rock}.wav, impact/water_01–05.wav,
scrape/rock.wav. Wind/river levels were raised in src/audio/ambience.ts.
