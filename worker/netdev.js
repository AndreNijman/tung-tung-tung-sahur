// netdev.js v1 (canonical copy: games-site shared/net/).
//
// Dev join. A dev is anyone games-guard's Cloudflare Access admin page lets in
// (ADMIN_EMAILS): opening that page marks the browser, and from then on every
// game host's /_guard/dev hands it a short-lived pass signed by games-guard.
// The client sends the pass in its create or join message; the relay checks
// it against the public key below, so no relay holds a secret or an admin
// list. A dev may join any room, even locked, full or mid-match, and the
// relay tells the room with {t:'dev-joined', name}, which every client shows
// with showDevJoined(). Admins reach a room from the admin page through
// https://<game host>/?join=CODE, which every client honours (joinCode()).
// setPlayer() tells the admin page's live view who is playing, and where.
// Shared, unchanged, by every game client and relay.

/** games-guard's Ed25519 public key (raw, base64url). Its private half is the guard secret DEV_SIGNING_KEY. */
export const DEV_PUBLIC_KEY = '0_eVFvtfeB30dok5z32bp942TUbLInZ4zM5iWDZ5NlY';

const PASS_TTL_S = 15 * 60;

function b64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  const plain = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

/** A dev's display name: capitals, digits and spaces, at most 16, e.g. "ANDRE". */
export function cleanDevName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

// -- relay -------------------------------------------------------------------

const keys = new Map();
function publicKey(raw) {
  if (!keys.has(raw)) keys.set(raw, crypto.subtle.importKey('raw', unb64url(raw), { name: 'Ed25519' }, false, ['verify']));
  return keys.get(raw);
}

/**
 * The dev a pass names, { name }, or null when it is missing, forged, expired
 * or for another game. `host` is the relay's own game, e.g.
 * 'fart.andrenijman.com'. Tests pass their own `publicKey`.
 */
export async function verifyDevPass(pass, host, options = {}) {
  try {
    const [version, body, signature] = String(pass || '').split('.');
    if (version !== 'v1' || !body || !signature || pass.length > 600) return null;
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, await publicKey(options.publicKey || DEV_PUBLIC_KEY),
      unb64url(signature), new TextEncoder().encode(`v1.${body}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(unb64url(body)));
    const name = cleanDevName(claims.n);
    const now = options.now ?? Date.now();
    if (!name || claims.h !== host || !(claims.x * 1000 > now)) return null;
    return { name };
  } catch {
    return null;
  }
}

/** games-guard's half (and the tests'): a pass for `name` on `host`. `privateKey` is PKCS#8, base64url. */
export async function signDevPass(privateKey, { name, host, ttl = PASS_TTL_S, now = Date.now() }) {
  const key = await crypto.subtle.importKey('pkcs8', unb64url(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const exp = Math.floor(now / 1000) + ttl;
  const body = b64url(new TextEncoder().encode(JSON.stringify({ n: cleanDevName(name), h: host, x: exp })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`v1.${body}`)));
  return { pass: `v1.${body}.${b64url(signature)}`, exp };
}

// -- client ------------------------------------------------------------------

let held = null;
let pending = null;

// Passes come from games-guard, which serves every game host; elsewhere
// (local dev, file://, a mirror) nobody is a dev.
function guarded() {
  return typeof location !== 'undefined' && location.protocol === 'https:' && /(^|\.)andrenijman\.com$/.test(location.hostname);
}

/**
 * This browser's dev pass, { name, pass }, or null for everyone else. Fetch
 * it just before sending create or join; it is reused until a minute before
 * it expires.
 */
export function devPass() {
  if (!guarded()) return Promise.resolve(null);
  if (held && held.exp * 1000 - Date.now() > 60_000) return Promise.resolve(held.dev);
  pending ||= fetch('/_guard/dev', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const dev = data?.dev && data.pass ? { name: cleanDevName(data.name), pass: data.pass } : null;
      held = dev ? { dev, exp: data.exp } : null;
      return dev;
    })
    .catch(() => null)
    .finally(() => { pending = null; });
  return pending;
}

/** The room code from a ?join=CODE link (the admin page's), or null. */
export function joinCode() {
  if (typeof location === 'undefined') return null;
  const code = new URLSearchParams(location.search).get('join');
  return code ? code.trim().slice(0, 40) : null;
}

/** Drops ?join= from the address bar once it has been used, so a reload doesn't rejoin. */
export function clearJoinCode() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  if (!url.searchParams.has('join')) return;
  url.searchParams.delete('join');
  history.replaceState(history.state, '', url);
}

/**
 * Who this tab is playing as, and in which room (null when not in one), for
 * the admin page's live view. Call it on joining, on leaving and when the
 * player renames.
 */
export function setPlayer(name, room) {
  if (typeof window === 'undefined') return;
  window.__gamesPlayer = { name: String(name || '').slice(0, 24), room: room ? String(room).slice(0, 40) : '' };
}

let bannerTimer = 0;

/** "DEV ANDRE HAS JOINED", big, in the middle of the screen, for four seconds. */
export function showDevJoined(name) {
  if (typeof document === 'undefined') return;
  const label = cleanDevName(name) || 'A DEV';
  let banner = document.getElementById('dev-joined-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'dev-joined-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'z-index:2147483647', 'pointer-events:none',
      'transform:translate(-50%,-50%) scale(.9)', 'opacity:0', 'transition:opacity .25s ease,transform .25s ease',
      'padding:.55em 1.1em', 'border:3px solid #ffd23f', 'border-radius:6px', 'background:rgba(12,10,20,.88)',
      'color:#fff', 'font:800 clamp(22px,4.5vw,48px)/1.1 system-ui,sans-serif', 'letter-spacing:.06em',
      'text-align:center', 'white-space:nowrap', 'text-shadow:0 3px 0 #000', 'box-shadow:0 10px 40px rgba(0,0,0,.5)',
    ].join(';');
    (document.body || document.documentElement).appendChild(banner);
  }
  banner.textContent = '';
  const tag = document.createElement('span');
  tag.textContent = `DEV ${label}`;
  tag.style.color = '#ffd23f';
  banner.append(tag, ' HAS JOINED');
  requestAnimationFrame(() => { banner.style.opacity = '1'; banner.style.transform = 'translate(-50%,-50%) scale(1)'; });
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.style.opacity = '0'; banner.style.transform = 'translate(-50%,-50%) scale(.9)'; }, 4000);
}
