// netplace.js v1 (canonical copy: games-site shared/net/).
//
// Relay half of room placement. A room's Durable Object runs where it was
// first reached, near whoever created it. That suits a group from one place;
// a mixed group (three players in Europe, one in Asia) leaves someone far
// away. Each client measures its ping to every Cloudflare region with
// netprobe.js and tells the relay; at match start the relay asks
// chooseRegion() whether another region would make the worst player's ping
// clearly better, and if so moves the room to a fresh Durable Object placed
// there (a "shard", see roomStub). Also: where each player connects from, for
// the lag log. Shared, unchanged, by every game relay.

/** Cloudflare Durable Object location hints. */
export const REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];

export const REGION_NAMES = {
  wnam: 'US West', enam: 'US East', sam: 'South America', weur: 'Western Europe', eeur: 'Eastern Europe',
  apac: 'Asia', oc: 'Oceania', afr: 'Africa', me: 'Middle East',
};

// Cloudflare colos (IATA codes) by region, for rooms that were placed by
// their creator rather than by a hint. A colo not listed has no region and
// such a room is never moved.
const COLO_REGION = {};
for (const [region, colos] of Object.entries({
  wnam: 'SJC SFO LAX SEA PDX LAS PHX DEN SLC SAN SMF YVR YYC ABQ OAK BUR ONT',
  enam: 'IAD EWR JFK LGA BOS ATL MIA ORD DFW IAH YYZ YUL CLT PHL MSP DTW STL MCI BNA TPA MCO PIT CMH IND RIC JAX AUS SAT MEM OMA MEX QRO GDL YOW YHZ',
  sam: 'GRU GIG EZE SCL BOG LIM UIO FOR POA CWB MDE PTY VCP BSB SSA REC MVD ASU CCS SJO GUA',
  weur: 'LHR LGW MAN EDI DUB AMS FRA CDG MRS MAD BCN LIS BRU ZRH GVA MUC DUS HAM STR TXL BER MXP FCO CPH OSL ARN GOT LUX LYS BOD NCE PMO',
  eeur: 'WAW PRG BUD OTP SOF VIE HEL RIX TLL VNO KBP ATH BEG ZAG LJU KIV SKG DME SVO LED MSQ BTS',
  apac: 'SIN HKG NRT HND KIX ICN TPE BOM DEL MAA BLR HYD CCU AMD KUL BKK CGK MNL SGN HAN KTM DAC CMB KHI ISB LHE PNH RGN FUK OKA CEB DPS',
  oc: 'SYD MEL BNE PER ADL CBR HBA AKL CHC WLG NOU',
  afr: 'JNB CPT DUR LOS NBO ACC DAR MBA ADD KGL LAD MPM TUN ALG CMN DKR',
  me: 'DXB AUH DOH BAH KWI RUH JED DMM TLV AMM MCT IST BEY BGW EVN TBS GYD CAI',
})) for (const colo of colos.split(' ')) COLO_REGION[colo] = region;

/** The region a Cloudflare colo is in, or '' when unknown. */
export function regionOfColo(colo) {
  return COLO_REGION[String(colo || '').toUpperCase()] || '';
}

const clean = (v, n) => String(v || '').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase();

/**
 * Where a player connects from, read in the relay Worker's fetch (request.cf
 * is only reliable there): `{ country, edge }`, the ISO country and the
 * Cloudflare colo they came in through. `trustHeaders` is for a relay behind
 * games-guard's proxy (tung), which sees the proxy's hop instead and gets the
 * player's from X-Games-Country / X-Games-Edge.
 */
export function playerWhere(request, { trustHeaders = false } = {}) {
  const h = request.headers;
  return {
    country: clean((trustHeaders && h.get('X-Games-Country')) || request.cf?.country, 2),
    edge: clean((trustHeaders && h.get('X-Games-Edge')) || request.cf?.colo, 4),
  };
}

/** A copy of `request` for the room's Durable Object that carries `where` (read back with whereOf). */
export function withWhere(request, where) {
  const forwarded = new Request(request);
  forwarded.headers.set('X-Games-Country', where.country);
  forwarded.headers.set('X-Games-Edge', where.edge);
  return forwarded;
}

/** In the room's Durable Object: where the player on this request is. */
export function whereOf(request) {
  return { country: clean(request.headers.get('X-Games-Country'), 2), edge: clean(request.headers.get('X-Games-Edge'), 4) };
}

/** How much the worst player's ping must improve before a room moves. */
export const MOVE_GAIN_MS = 80;
/** A ping over this counts as laggy (games-guard's LAG_LIMITS.rttP95). */
const LAGGY_MS = 200;

/**
 * Whether to move a room at match start, and where: `{ region, worst, from }`
 * (the worst player's ping there and here, ms), or null to stay.
 * Each player is `{ probes, rtt }`: their netprobe.js results
 * ({ weur: 38, apac: 290 }, ms; null if their client sent none) and their
 * measured ping to this room now (NetStats / NetPing rtt; a region's probe is
 * a poor stand-in for a room, as one hint covers several colos).
 * `via` is for relays where one player (the host) runs the game and the
 * others reach them through the relay: the host as `{ probes, rtt }`, with
 * `players` then the others; each player's cost is theirs plus the host's.
 * The best region has the fewest laggy players, then the lowest worst ping,
 * then the lowest total. Stays put unless every player has probes and a ping
 * here, and the worst player gains at least `gain` ms without anyone else
 * becoming laggy.
 * @param {Array<{ probes: Record<string, number> | null, rtt: number | null }>} players
 * @param {{ via?: { probes: Record<string, number> | null, rtt: number | null } | null, gain?: number }} [options]
 */
export function chooseRegion(players, { via = null, gain = MOVE_GAIN_MS } = {}) {
  const everyone = via ? [...players, via] : players;
  if (players.length < (via ? 1 : 2) || everyone.some((p) => !p?.probes || !(p.rtt > 0))) return null;
  const score = (msOf) => {
    let worst = 0;
    let total = 0;
    let laggy = 0;
    for (const p of players) {
      const ms = msOf(p) + (via ? msOf(via) : 0);
      if (!Number.isFinite(ms) || ms <= 0) return null;
      worst = Math.max(worst, ms);
      total += ms;
      if (ms > LAGGY_MS) laggy++;
    }
    return { worst, total, laggy };
  };
  const here = score((p) => Number(p.rtt));
  if (!here) return null;
  let best = null;
  for (const region of REGIONS) {
    const c = score((p) => Number(p.probes?.[region]));
    if (c && (!best || (c.laggy - best.laggy || c.worst - best.worst || c.total - best.total) < 0)) best = { region, ...c };
  }
  if (!best || here.worst - best.worst < gain || best.laggy > here.laggy) return null;
  return { region: best.region, worst: Math.round(best.worst), from: Math.round(here.worst) };
}

const SHARD = /^(wnam|enam|sam|weur|eeur|apac|oc|afr|me)-[a-z0-9]{6}$/;

/** A fresh shard name in `region`, e.g. "apac-k3f9q2". */
export function newShard(region) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${region}-${[...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
}

/** The region a shard name was made for, or '' if `shard` is not one. */
export function shardRegion(shard) {
  return SHARD.exec(String(shard || ''))?.[1] || '';
}

/**
 * The Durable Object for room `code`, or for its moved copy `shard`, which is
 * created in the shard's region. Use it everywhere a relay looks up a room.
 */
export function roomStub(namespace, code, shard = '') {
  const region = shardRegion(shard);
  if (!region) return namespace.get(namespace.idFromName(code));
  return namespace.get(namespace.idFromName(`${code}~${shard}`), { locationHint: region });
}
