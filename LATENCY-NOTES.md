# Latency notes (tung)

Step 0 of the latency work, written before any sim/render edit. Line numbers
are for origin/main 68dfd35.

## Authority model: (b), with client-owned movement

The room's Durable Object (`Room`, worker/relay.js) runs the night: the clock,
pickups, deliveries, catches, hiding, alcove swaps, bot Tungs and the result
(`tickOnce`, worker/relay.js:1094-1123; `resolvePickups`/`resolveDeliveries`/
`resolveCatches`, :1138-1184; `handleHide`/`handleSwap`, :1357-1441). Clients
render its 20 Hz snapshots.

Each client owns its own position: it moves locally and sends `in {x, y, a, f}`
at 20 Hz (index.html:5937-5959). The relay accepts it under a speed budget
(`handleInput`, worker/relay.js:1305-1355) and never sends a correction back
(index.html:5629-5632). So it is (b) for everything except the local body,
which behaves like (a).

The level itself is generated client-side from the relay's seed; the host
sends the resulting manifest (items, alcoves, grid) and the relay validates it
(`setManifest`, worker/relay.js:989-1062).

## What already hides delay

- Local movement: predicted with no round trip and never reconciled
  (index.html:5629-5632; `game.update` moves `game.px/py` locally; `sendInput`
  index.html:5953-5959 reports it).
- Local actions: hiding shows "ENTERING ALCOVE" at once while the relay
  confirms (`hidePending`, index.html:2195 and the HUD at :3224); an alcove swap
  starts its local transit animation at once (`swapTransit`, index.html:2266).
- Remote bodies: an exponential chase toward the newest snapshot position,
  `k = min(1, dt*12)` per frame (`Net.update`, index.html:5937-5945). No buffer,
  no timestamps: a late snapshot makes the body slow down and then jump.
  Footprints for a Tung use the raw snapshot rows (index.html:5802).

## Rates and messages

- Relay tick 20 Hz (`TICK_HZ`, worker/relay.js:15). Each tick sends every
  player their own `snap` (`broadcastSnapshot`, :1222): tick `k`, clock `tl`,
  all actors `p`, items `it`, sprays `sp`. So 20 snapshots/s per client.
- Client → relay: `in` 20/s while alive; `ping` 1/s from socket open (lobby
  included; index.html:5676-5678), answered with `pong`.
- Events (`ev`: pickup, deliver, drop, caught, hide, swap, spray, votekick)
  and `chat`/`roster` as they happen.

## Room lifecycle

- Create: the Worker allocates a five-character code from the `Registry` DO
  (worker/relay.js:1505-1517), then routes the socket to
  `ROOMS.getByName(code)`; the first message is `create`
  (`initializeSession`, :515-616).
- Join: `?code=ABCDE`, first message `join` (password, phase and size checks).
- Start, i.e. "match start": the host's `start` (or an admin's `admin-start`)
  message, `handleMessage` worker/relay.js:644-646 and :692-694, calls
  `start()` (:932-987), which picks the Tung(s), seeds the street and
  broadcasts `begin`. The host then sends the manifest and the tick starts
  producing snapshots.
- End: `finish()` (:1238) on escape / catch-out / dawn / abandonment; `again`
  returns to the lobby (`backToLobby`, :1267). The room resets when the last
  player leaves (`removePlayer` → `resetRoom(true)`, :806-846).
- Pings already flow in the lobby, so a room has each player's recent ping
  before the host presses start.

## Item 1 plan

- Remote bodies: replace the chase with a snapshot buffer. Each snapshot is
  stamped with server time `k * 50 ms`; the client tracks the least-late
  arrival (clock offset) and renders at an adaptive delay of about the
  95th-percentile inter-arrival gap (clamped), interpolating between the two
  surrounding samples, extrapolating at most 100 ms on a gap and snapping on
  teleports (alcove swaps, respawn, long gaps). The render clock is slewed
  smoothly so delay changes never jump the picture.
- The wire protocol does not change (snapshots already carry `k`; the Node
  relay server/relay.js:758 sends it too).
- Local player: nothing to add. Movement is already immediate, and the two
  relay-confirmed actions (hide, swap) already show local feedback at once.
  Pickups and deliveries stay relay-decided; predicting them would show
  offerings the relay then refuses.
- Measure (tests/latency/harness.mjs): 200 ms RTT, ±40 ms jitter, the old
  chase (taken from origin/main) against the buffer: stutter frames % and
  path error after removing each method's own delay, plus that delay.

## Item 1 result (after the work)

The plan above changed once it met the measurement. Stamping samples with
the relay tick `k` alone made things worse (stutter 17.7% -> ~48%): the
sender's leg to the relay is jittered too, so the positions that land in
consecutive ticks are unevenly spaced in time, and interpolating them evenly
draws the unevenness. So the protocol gained one optional field each way,
both backward compatible:

- `in` gains `s`: the sender's `performance.now()` when it sent that position.
- A visible player's snapshot row gains an 8th element: the `s` of the
  position the relay last accepted for them. Old clients ignore it; an old
  relay omits it and the buffer falls back to the tick clock (bots always use
  the tick clock).

Each remote body now has its own track on its own clock (index.html
`SnapBuffer`): least lateness over 3 s plus the p95 arrival gap (clamped
50-250 ms), slewed at most 10%, interpolate, coast at most 100 ms, snap on a
step over 1.5 tiles or a gap over 1 s.

`node tests/latency/harness.mjs`, 5 seeds x 60 s, 200 ms RTT ±40 ms
(each leg 100 ± 20, order kept):

| | before (chase) | after |
|---|---|---|
| stutter frames | 17.7 % | 0.2 % |
| path shape error | 0.037 tiles | 0.012 tiles |
| drawn delay | 316 ms | 301 ms |
| error vs. true position now | 0.794 tiles | 0.757 tiles |

At 40 ms RTT, no jitter: delay 156 -> 122 ms, stutter 0.4 -> 0.1 %.
