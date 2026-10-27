// Unit tests for the Cloudflare relay's Room (worker/relay.js) outside
// Workers: a night's lag log reaches games-guard's NetLog exactly once.
//
//   node --test tools/relay-test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../worker/relay.js';

function makeRoom(logs) {
  const env = {
    NETLOG: { record: async (game, log) => { logs.push({ game, log }); return { ok: true }; } },
    REGISTRY: { getByName: () => ({ fetch: async () => new Response('{}') }) },
  };
  const room = new Room({ waitUntil() {} }, env);
  room.created = true;
  room.code = 'BCDFG';
  room.colo = 'PER';
  return room;
}

function player(id, name) {
  return {
    id, name, socket: { readyState: 1, send() {} },
    publicLobby() { return { id, name, role: this.role }; },
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a finished night sends its lag log to games-guard', async () => {
  const logs = [];
  const room = makeRoom(logs);
  const ana = player(1, 'Ana'), budi = player(2, 'Budi');
  room.addPlayer(ana);
  room.addPlayer(budi);
  room.start();
  room.net.startedAt -= 60_000;
  const pongs = [];
  ana.socket.send = text => { const msg = JSON.parse(text); if (msg.t === 'pong') pongs.push(msg.c); };
  for (let k = 0; k < 20; k++) {
    for (const [who, rtt, fps, frameMax] of [[ana, 40 + k, 60, 20], [budi, 300 + k, 58, 35]]) {
      const session = { initialized: true, closed: false, player: who, socket: who.socket };
      await room.onSocketMessage(session, JSON.stringify({ t: 'ping', c: k, rtt, fps, frameMax }));
    }
  }
  assert.equal(pongs.length, 20, 'every ping is answered with its c');
  assert.equal(pongs[19], 19);

  room.finish('escaped', 'every offering reached the surau');
  await tick();

  assert.equal(room.phase, 'over');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].game, 'tung');
  const { log } = logs[0];
  assert.equal(log.outcome, 'finished');
  assert.equal(log.colo, 'PER');
  assert.equal(log.code, 'BCDFG');
  assert.deepEqual(log.seats.map(seat => seat.name), ['Ana', 'Budi']);
  assert.ok(log.seats[1].rttP95 >= 300 && log.seats[0].rttP95 < 100);
  assert.equal(log.seats[0].fpsMed, 60);
  assert.equal(log.seats[1].frameMax, 35);
  assert.equal(room.net, null);

  room.backToLobby();
  await tick();
  assert.equal(logs.length, 1, 'returning to the lobby after the result does not log twice');
});

test('an abandoned night is logged once, a too-short one not at all, a closed room once', async () => {
  const logs = [];
  const room = makeRoom(logs);
  room.addPlayer(player(1, 'Ana'));
  room.addPlayer(player(2, 'Budi'));
  room.start();
  room.backToLobby();
  await tick();
  assert.equal(logs.length, 0);

  room.start();
  room.net.startedAt -= 30_000;
  room.finish('abandoned', 'the tung left the street');
  room.backToLobby();
  room.resetRoom();
  await tick();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].log.outcome, 'abandoned');

  room.addPlayer(player(3, 'Citra'));
  room.addPlayer(player(4, 'Dewi'));
  room.start();
  room.net.startedAt -= 30_000;
  room.resetRoom();
  await tick();
  assert.equal(logs.length, 2);
  assert.equal(logs[1].log.outcome, 'closed');
});
