# Tung Tung Tung Sahur

A first-person raycaster horror game that runs in one HTML file. No build step,
no dependencies, no assets — every sprite is drawn with canvas calls and every
sound is synthesised in the Web Audio API at load.

**Play: https://andrenijman.github.io/tung-tung-tung-sahur/**

---

## The night

It is the dead hour before dawn. The drumming thing walks the streets to wake
the sleepers for sahur. It calls three times. Tung. Tung. Tung.

You left the surau to gather six offerings. You have four minutes of dark to
find all six and carry them back through the door you came out of. You cannot
fight it. You can only be somewhere it is not looking.

| key | |
|---|---|
| `W` `A` `S` `D` | move |
| `Shift` | sprint — fast, loud, and short |
| mouse / `←` `→` | look |
| `F` | torch — you see further, so does it |
| `E` | duck into a shelter alcove |
| `R` | restart from an end screen |

## What it knows about you

- **Sight** needs three things at once: range, an unbroken line, and you inside
  the cone it is facing. It looks where it is walking and its head turns at a
  finite rate, so the moment after it rounds a corner is your window. If you
  cannot see its eyes, it cannot see you.
- **Hearing** is not directional and no wall stops it. Sprinting carries
  furthest, walking carries less, standing still carries nothing — unless your
  nerve is gone.
- **Nerve** is not decoration. Below a quarter you are breathing hard enough to
  be heard standing perfectly still, and you get your wind back at half speed.
  An alcove is the only place it comes back, and the clock keeps running while
  you sit in one.
- **Losing it** means breaking line of sight and staying broken. When it reaches
  where it last saw you and you are not there, it does not know where you went —
  it casts about nearby. It does not walk to where you actually are.

## Three ways the night ends

Reach the surau with all six. Get caught. Or let the call to Subuh go up over
the rooftops while you are still out there.

---

## Development

The whole game is `index.html`. Everything above the `>>> SIM CUT <<<` marker is
pure simulation with no DOM, audio or `requestAnimationFrame` in it; everything
below is browser-only. Keeping that split is what makes the game testable.

```bash
npm install                       # only needed for the browser smoke test

node tools/sim.js                 # headless balance runs
node tools/smoke.js               # drive the real page in Chromium
```

### `tools/sim.js` — balance harness

Loads the simulation half into a `vm` with stubbed globals and a seeded
`Math.random`, then plays it with a bot. Two dials, because they answer
different questions:

- `--knowledge omniscient|blind` — whether the bot already knows where the
  offerings are, or has to find them by line of sight. `blind` is the realistic
  one and the one the night length is tuned against.
- `--threat greedy|flee` — whether it keeps walking to its goal while hunted, or
  runs. `flee` is what answers "can you outrun it".

`--set NAME=VALUE` patches any top-level constant before evaluation, so you can
sweep balance without editing the game:

```bash
node tools/sim.js --knowledge blind --threat flee --set CREATURE_HUNT_BASE=2.45
```

Current numbers, 200 runs each:

| bot | win | caught | dawn | extraction leg |
|---|---|---|---|---|
| blind / flee | 33.5% | 60.0% | 6.5% | 16.6s mean |
| omniscient / flee | 37.0% | 55.5% | 7.5% | 18.6s mean |
| blind / greedy | 18.0% | 82.0% | — | 12.5s mean |
| omniscient / greedy | 27.0% | 73.0% | — | 13.7s mean |

The gap between `flee` and `greedy` is the skill headroom: ignoring the creature
adds twenty-plus points to your death rate.

**What actually bounds a chase is the clock, not the hunt speed.** Hunt speed
used to sit at 2.0 against a walk speed of 2.2, so a fleeing player could
neither be caught nor shake the creature off. Raising it above walk speed does
not fix that on its own — with the night disabled and a 300s cap, the share of
runs that never resolve is 18.3% at 2.0 and 16.7% at 2.30. That is one run apart
on n=60, so this test does not show the change helping:

```bash
node tools/sim.js --threat flee --cap 300 --set NIGHT_SECONDS=100000 --set CREATURE_HUNT_BASE=2.0
```

The finite night is what makes those runs terminate; they end at dawn instead of
running forever. `CREATURE_HUNT_BASE = 2.30` is justified on the clocked sweeps
(it balances better than 2.0 or 2.45) and structurally — above walk speed,
fleeing on foot always loses ground — but not on the treadmill number. Part of
the residual is the bot itself: it flees in straight lines down corridors, which
is exactly the behaviour that keeps a creature in line of sight.

**The night length is the least validated number here.** `NIGHT_SECONDS = 240`
was tuned against a bot that averages nine alcove visits per run, because it
sits in cover resting its nerve back above 0.5 before moving on. A player who
hides less than that will find four minutes loose; one who hides more will find
it brutal. Nothing in the harness settles this — only playing it does.

### `tools/smoke.js` — browser smoke test

Covers what the sim cannot reach — the sprite cache, HUD, compass arrows and all
four end screens — by driving the real page in Chromium. Fails on any console
error, page error or failed request, and writes screenshots to `shots/`.

## Licence

None yet. The repository is public but no licence is granted, which means
default copyright applies.
