// The home's live feed (server/homefeed.ts): home/ws pushes what changed in the home, in place of reading `games`
// every 2 s. `merge` puts one message in the state; `follow` keeps the socket open, comes back after it drops (with the
// poll, app.js, filling in meanwhile) and `sync` asks for a fresh look after doing something. No DOM here: tested alone.

/** The sections a message may bring whole. */
const SECTIONS = ['me', 'last', 'favorites', 'publicUrl', 'people', 'social'];

/** One pushed message into `state`: whole sections, the library whole (`games`) or only the games that changed (`game`). */
export function merge(state, m) {
  for (const k of SECTIONS) if (k in m) state[k] = m[k] ?? (k === 'people' || k === 'favorites' ? [] : null);
  if (m.games) state.games = m.games;
  else if (m.game && state.games) {
    const by = new Map(m.game.map((g) => [g.key, g]));
    state.games = state.games.map((g) => by.get(g.key) ?? g);
  }
}

/** The pass expired (homefeed.ts' EXPIRED): no coming back, the poll gets its 403. */
export const EXPIRED = 4003;
/** A sync not answered by then: the poll asks instead. */
export const SYNC_MS = 5000;

/**
 * Follows the feed at `url`: `apply(message)` for each one, `down(code)` when it closes (the poll takes over until it
 * comes back, a second later, then 2, 4… up to 30 s while it keeps failing). `live` once its first message (the whole
 * home) is in. `again()` says whether to come back at all.
 */
export function follow(url, { apply, down = () => {}, again = () => true, WebSocket = globalThis.WebSocket, setTimeout = globalThis.setTimeout }) {
  let ws = null;
  let live = false;
  let wait = 1000;
  let n = 0;
  /** sync's waiting for their answer, by number */
  const waiting = new Map();
  /** Answers the syncs up to `upTo` (only that one, `one`). */
  const settle = (upTo, ok, one = false) => {
    for (const [id, done] of waiting) if (one ? id === upTo : id <= upTo) { waiting.delete(id); done(ok); }
  };

  function open() {
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      live = true;
      wait = 1000;
      apply(m);
      if (m.sync) settle(m.sync, true);
    };
    ws.onclose = (e) => {
      live = false;
      settle(Infinity, false);
      down(e.code);
      if (e.code !== EXPIRED && again()) { setTimeout(open, wait); wait = Math.min(wait * 2, 30_000); }
    };
  }
  open();

  return {
    get live() { return live; },
    /** A fresh look, now: true once it's applied; false when the socket isn't there to ask, or didn't answer (poll instead). */
    sync() {
      if (!live) return Promise.resolve(false);
      const id = ++n;
      ws.send(JSON.stringify({ sync: id }));
      setTimeout(() => settle(id, false, true), SYNC_MS);
      return new Promise((done) => waiting.set(id, done));
    },
  };
}
