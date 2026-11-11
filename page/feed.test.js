import { expect, test } from 'bun:test';
import { EXPIRED, follow, merge, SYNC_MS } from './home/feed.js';

test('merge: whole sections, the library whole, or only the games that changed', () => {
  const state = { me: '', games: null, people: [], social: null };
  merge(state, { me: 'Ana', last: null, publicUrl: '', games: [{ key: 'a', n: 1 }, { key: 'b', n: 1 }], people: [{ id: '2' }], social: null });
  expect(state).toEqual({ me: 'Ana', last: null, publicUrl: '', games: [{ key: 'a', n: 1 }, { key: 'b', n: 1 }], people: [{ id: '2' }], social: null });
  merge(state, { game: [{ key: 'b', n: 2 }] });
  expect(state.games).toEqual([{ key: 'a', n: 1 }, { key: 'b', n: 2 }]);
  expect(state.people).toEqual([{ id: '2' }]);
  merge(state, { people: [], social: { friends: [] } });
  expect([state.people, state.social, state.me]).toEqual([[], { friends: [] }, 'Ana']);
  merge(state, { games: [{ key: 'c' }] });
  expect(state.games).toEqual([{ key: 'c' }]);
});

/** A fake WebSocket and clock: the sockets made, their messages sent, the timers set. */
function world() {
  const sockets = [];
  const timers = [];
  class WS {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(m) { this.sent.push(JSON.parse(m)); }
    push(m) { this.onmessage({ data: JSON.stringify(m) }); }
    drop(code = 1006) { this.onclose({ code }); }
  }
  return { sockets, timers, WebSocket: WS, setTimeout: (fn, ms) => timers.push({ fn, ms }) };
}

test('follow: live once the whole home is in, apply for each message, sync answered by its number', async () => {
  const w = world();
  const got = [];
  const feed = follow('ws://x/home/ws', { apply: (m) => got.push(m), WebSocket: w.WebSocket, setTimeout: w.setTimeout });
  expect(feed.live).toBe(false);
  // (not live: a sync says to poll instead)
  expect(await feed.sync()).toBe(false);
  const ws = w.sockets[0];
  ws.push({ me: 'Ana', games: [] });
  expect(feed.live).toBe(true);
  const a = feed.sync();
  const b = feed.sync();
  expect(ws.sent).toEqual([{ sync: 1 }, { sync: 2 }]);
  let done = [];
  a.then((v) => done.push(['a', v]));
  b.then((v) => done.push(['b', v]));
  // another message first (a tick): not the answer
  ws.push({ people: [] });
  await Bun.sleep(0);
  expect(done).toEqual([]);
  ws.push({ sync: 2 });
  await Bun.sleep(0);
  expect(done).toEqual([['a', true], ['b', true]]);
  expect(got).toEqual([{ me: 'Ana', games: [] }, { people: [] }, { sync: 2 }]);
  // junk is skipped
  ws.onmessage({ data: 'nope' });
  expect(got).toHaveLength(3);
});

test('follow: dropped, the poll takes over and it comes back after 1 s, 2 s, 4 s… up to 30 s; never once expired', async () => {
  const w = world();
  const downs = [];
  let again = true;
  const feed = follow('ws://x/home/ws', { apply() {}, down: (c) => downs.push(c), again: () => again, WebSocket: w.WebSocket, setTimeout: w.setTimeout });
  w.sockets[0].push({ games: [] });
  const waiting = feed.sync();
  w.sockets[0].drop();
  expect(await waiting).toBe(false);
  expect(feed.live).toBe(false);
  expect(downs).toEqual([1006]);
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const t = w.timers.filter((x) => x.ms !== SYNC_MS).at(-1);
    waits.push(t.ms);
    t.fn();
    w.sockets.at(-1).drop();
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  // back: the wait starts over
  w.timers.at(-1).fn();
  w.sockets.at(-1).push({ games: [] });
  w.sockets.at(-1).drop();
  expect(w.timers.at(-1).ms).toBe(1000);
  // expired: no coming back (the poll gets the 403); nor when `again` says not to (the page knows it expired)
  w.timers.at(-1).fn();
  const timers = w.timers.length;
  w.sockets.at(-1).drop(EXPIRED);
  expect(w.timers.length).toBe(timers);
  expect(downs.at(-1)).toBe(EXPIRED);
  again = false;
  follow('ws://x/home/ws', { apply() {}, again: () => again, WebSocket: w.WebSocket, setTimeout: w.setTimeout });
  w.sockets.at(-1).drop();
  expect(w.timers.length).toBe(timers);
});

test("follow: a sync the server doesn't answer gives way to the poll", async () => {
  const w = world();
  const feed = follow('ws://x/home/ws', { apply() {}, WebSocket: w.WebSocket, setTimeout: w.setTimeout });
  w.sockets[0].push({ games: [] });
  const waiting = feed.sync();
  const timer = w.timers.find((x) => x.ms === SYNC_MS);
  timer.fn();
  expect(await waiting).toBe(false);
});
