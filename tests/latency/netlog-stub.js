// A stand-in for games-guard's NetLog under wrangler dev, for
// tests/latency/rooms.test.mjs. The relay's NETLOG service binding (service
// "games-guard", entrypoint NetLog) reaches this worker through wrangler's dev
// registry; GET /records returns every record it was sent. Records live in one
// Durable Object, since the entrypoint and fetch may run in separate isolates.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class Records extends DurableObject {
  list = [];
  add(entry) { this.list.push(entry); }
  all() { return this.list; }
}

export class NetLog extends WorkerEntrypoint {
  async record(game, record) {
    await this.env.RECORDS.getByName('all').add({ game, record });
    return { ok: true };
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/records') return Response.json(await env.RECORDS.getByName('all').all());
    return new Response('netlog stub\n');
  },
};
