# Tung Tung Tung Sahorror

A first-person raycaster horror game with solo and 2-5 player multiplayer. The
client is one HTML file: no build step, no assets, and every sprite and sound is
generated in the browser. Multiplayer uses a zero-dependency Node WebSocket
relay in `server/relay.js`.

**Play: https://tung.andrenijman.com/**

originally by tim

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
| `Q` | slip through to the paired alcove while hidden |
| `T` | runner team chat; player Tungs cannot receive it |
| `Esc` | pause — also fires on alt-tab or losing pointer lock |
| `R` | restart from a solo end screen |

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

## Multiplayer

Create a lobby and share its five-character code, or join directly from the live
available-lobbies list. A lobby holds at most ten players and starts with two
or more. An optional password can protect the room; relays store only its
SHA-256 digest and the public list exposes only a `LOCKED` marker. Everyone
votes for a player to become the first Tung, or votes to leave it random. A strict
plurality wins; ties and a winning random vote are resolved randomly. Hosts can
select up to three player Tungs, capped so at least one runner remains.

The host controls the map size, number of lanterns, night timer, torch duration
(including infinite), runner stamina, whether Tungs can see objectives, the
number of player Tungs, and how clearly Tungs can read tracks.

## Progression and cosmetics

Finished games award XP and T-bucks from individual contribution, survival,
time played, and the result. Five offerings in a loss are worth more than doing
nothing in a win. Currency and XP appear only in menus and result screens.

The 100-level Sahur Pass rewards every level and grants a cosmetic every fifth
level, ending with the legendary Sahur Sovereign. The item shop sells individual
legendary cosmetics and discounted bundles. Owned items, achievement sigils,
and outfits are managed in the wardrobe and never alter gameplay values.

On `tung.andrenijman.com`, signed-in profiles sync through the existing Games
Guard account session. Guests and local/self-hosted games use browser storage.

### Survivors

Survivors carry one lantern at a time. Walk over one to pick it up, then bring it
to the surau. A carried lantern lights up its carrier and makes their footprints
last longer. Getting caught drops it where the survivor fell. The survivors win
when every lantern is home.

### The Tung

The Tung is another player, not the solo AI. It walks faster than a survivor
walks but slower than a survivor sprints. `Shift` triggers a short surge on an
11-second cooldown.

The Tung's view is colourless and gives it no player markers or compass. It sees
footprints instead:

- Walking prints appear 1.4 seconds late and fade after 4 seconds.
- Sprinting leaves prints more often and they last 7 seconds.
- Carrying a lantern extends either trail by 40%.
- Standing still leaves no trail.
- Walls occlude prints, so the Tung must enter the corridor to read them.

This delay is the balance: the trail says where a survivor was, never where they
are now. The lobby's track setting can disable it or change delay, brightness,
and lifetime without changing any other rule.

### Paired alcoves

Every alcove has one deterministic partner a medium distance across the map.
Press `Q` while hidden to spend 1.2 seconds slipping through. The relay only
tells that survivor which alcove they reached; the Tung receives neither the
hidden position nor the swap event. A 12-second cooldown keeps alcoves from
becoming fast travel. Camping the door wastes the Tung's time without making
cover a free shortcut.

---

## Development

The whole game is `index.html`. Everything above the `>>> SIM CUT <<<` marker is
pure simulation with no DOM, audio or `requestAnimationFrame` in it; everything
below is browser-only. Keeping that split is what makes the game testable.

```bash
npm install                       # only needed for the browser smoke test

npm run serve                     # game + relay at http://localhost:8787
npm run sim                       # headless solo balance runs
npm run smoke                     # solo browser smoke test
npm run smoke:mp                  # real relay + five Chromium clients
```

### Relay and deployment

The relay owns room membership, voting, the clock, lantern pickup/delivery,
alcove swaps, catches, and match endings. Clients own their immediate movement
to avoid input latency; the relay bounds movement by elapsed wall time. Hidden
positions and swap destinations are withheld from other players. This is a
friends' game, not a ranked anti-cheat system: a modified client can still read
visible position snapshots or walk through walls.

`GET /lobbies` returns only joinable 1-4 player rooms with their code, host
display name, lock status and gameplay settings. Started, full and abandoned
rooms are not listed. The Cloudflare deployment keeps this directory in a
persistent Registry Durable Object; individual room/password state stays
isolated inside its Room Durable Object.

Run it directly:

```bash
PORT=8787 HOST=0.0.0.0 node server/relay.js --serve .
```

Or use the included production container:

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Put Caddy, nginx, Traefik, or another TLS reverse proxy in front of port 8787.
`server/Caddyfile.example` is a complete Caddy v2 example. The combined process
serves the page and WebSocket from the same origin, so the browser automatically
uses `wss://` on HTTPS with no separate relay configuration. Only `index.html`,
`CNAME`, and `/health` are exposed by the static server.

For a public relay, set a comma-separated origin allowlist, for example
`ALLOWED_ORIGINS=https://tung.andrenijman.com`. Leave it unset for local
`file://` development and smoke tests.

The live GitHub Pages build uses the Cloudflare Durable Object relay at
`tung-relay.tung-tung-tung-sahur.workers.dev`. The custom
`relay.tung.andrenijman.com` alias is also configured, but the client stays on
the Workers hostname so initial custom-domain certificate issuance cannot break
multiplayer. Its implementation is `worker/relay.js`; it speaks the same client
protocol and keeps each room inside one Durable Object. Deploy it with the
account-scoped token in `CLOUDFLARE_API_TOKEN`:

```bash
npx wrangler deploy
npm run smoke:mp:live
```

The Worker only accepts production-origin WebSockets (plus local development),
and `wrangler.jsonc` owns the custom relay domain and Durable Object migration.
GitHub Pages cannot run WebSockets itself, so the production client selects the
Cloudflare relay automatically. A custom relay address can still be entered in
the menu and is remembered locally. Serving both from the container remains the
simplest self-hosted layout.

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
| blind / flee | 35.0% | 57.5% | 7.5% | 17.7s mean |
| omniscient / flee | 37.0% | 54.5% | 8.5% | 20.0s mean |
| blind / greedy | 20.0% | 80.0% | — | 12.4s mean |
| omniscient / greedy | 25.5% | 74.5% | — | 13.9s mean |

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

### Browser smoke tests

`tools/smoke.js` covers the menu, paired-alcove transit, sprite cache, HUD,
compass arrows, pause and all four solo end screens. `tools/mp-smoke.js` starts a
real relay and five independent Chromium pages, then verifies lobby capacity,
public listing, locked/open rooms, wrong/correct password handling, host settings,
voting, seeded map agreement, pickup/delivery, delayed tracks, private alcove
swaps, catches, and disconnect cleanup. Both fail on any console, page or request
error; the solo test writes screenshots to `shots/`.

## Licence

None yet. The repository is public but no licence is granted, which means
default copyright applies.
