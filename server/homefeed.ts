/**
 * The home's live feed (p/<pass>/home/ws), in place of its poll of `games` every 2 s: one socket per open home, and the
 * server pushes only what changed since the last push to it (the header, each game of the library, Pessoas, Amigos).
 *
 * One look for everyone: a tick every TICK_MS while some home is open walks the library once (`shared`: the views made
 * at the same time share the walk under way), then makes each person's view from it and sends each socket its
 * differences.
 * A request that changes something (any method but GET, except an upload's pieces and a game's beats, routes.ts) and a
 * vimm.net download changing step `nudge` it: the walk is redone and the push comes within SOON_MS. What changes by itself (the builds in the queue, queue.ts; an upload gone quiet, an
 * invite expiring, someone's page no longer beating) shows on the next tick.
 *
 * The page keeps the poll for when the socket is down (Discord's proxy may cut it): `games` answers 304 when the view is
 * the same as the version it names (etagOf), so a quiet library costs a few bytes. The page names it as `?v=`, not in
 * If-None-Match: from its opaque origin that header costs a preflight per poll (Chrome keeps none for origin null).
 *
 * Messages, as JSON: the first one whole (`me`, `last`, `publicUrl`, `games`, `people`, `social`); then only the
 * sections that changed, with `games` whole when the library's games or their order changed, else `game`: the games
 * that changed. The page may send `{ sync: n }` (it just did something and wants the result): the answer comes at once,
 * fresh, with `sync: n` in it, even when nothing changed.
 */
import { log } from "./log";
import type { Pass } from "./pass";

export const TICK_MS = 2000;
/** A nudge's push comes this long after it, at the most: an upload's pieces come several a second. */
export const SOON_MS = 400;
/** The socket closed because the pass expired: the page's poll then gets its 403. */
export const EXPIRED = 4003;

export interface HomeView {
  me: string;
  last: string | null;
  publicUrl: string;
  games: { key: string }[];
  people: unknown;
  social: unknown;
}

/** What a home socket carries (routes.ts' NetData). */
export interface HomeData {
  pass: Pass;
  publicUrl: string;
}

export interface HomeSocket {
  data: HomeData;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

/** What a socket was last sent, section by section, as JSON. */
interface Sent {
  head: string;
  order: string;
  games: Map<string, string>;
  people: string;
  social: string;
}

/** A view's version, for the poll's ETag: the same JSON, the same tag. */
export const etagOf = (json: string) => `"${Bun.hash(json).toString(36)}"`;

/** Whether the request names this tag: its `?v=`, or its If-None-Match (one of a list, or *). */
export function unchanged(req: Request, tag: string) {
  const sent = req.headers.get("if-none-match") ?? new URL(req.url).searchParams.get("v");
  if (!sent) return false;
  return sent.split(",").some((t) => {
    const s = t.trim().replace(/^W\//, "");
    return s === tag || s === "*";
  });
}

/** The differences between `view` and what the socket had (`before`; null: nothing yet), and what it has after. */
export function diff(view: HomeView, before: Sent | null): { message: Record<string, unknown>; after: Sent } {
  const games = new Map(view.games.map((g) => [g.key, JSON.stringify(g)]));
  const after: Sent = {
    head: JSON.stringify([view.me, view.last, view.publicUrl]),
    order: JSON.stringify([...games.keys()]),
    games,
    people: JSON.stringify(view.people),
    social: JSON.stringify(view.social),
  };
  const message: Record<string, unknown> = {};
  if (after.head !== before?.head) Object.assign(message, { me: view.me, last: view.last, publicUrl: view.publicUrl });
  if (!before || after.order !== before.order) message.games = view.games;
  else {
    const changed = view.games.filter((g) => games.get(g.key) !== before.games.get(g.key));
    if (changed.length) message.game = changed;
  }
  if (after.people !== before?.people) message.people = view.people;
  if (after.social !== before?.social) message.social = view.social;
  return { message, after };
}

export interface HomeFeedOptions {
  /** One person's home, as `games` answers it (routes.ts). */
  view: (pass: Pass, publicUrl: string) => Promise<HomeView>;
  /** A home opened and closed (presence.ts: here while it's open). */
  connect?: (pass: Pass) => void;
  disconnect?: (pass: Pass) => void;
  now?: () => number;
  tickMs?: number;
  soonMs?: number;
}

export function createHomeFeed({ view, connect, disconnect, now = () => Date.now(), tickMs = TICK_MS, soonMs = SOON_MS }: HomeFeedOptions) {
  const sockets = new Map<HomeSocket, Sent | null>();
  /**
   * each socket's pushes, one after another: a tick's view begun before a change must not land after the sync that
   * shows it (the game removed would come back for a tick)
   */
  const queues = new Map<HomeSocket, Promise<void>>();
  /** bumped by each nudge: a walk made before it is not reused */
  let generation = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  /** how many times the library was walked and views were made (the tests, and the README's numbers) */
  const counts = { walks: 0, views: 0, pushes: 0 };

  /** Sends `ws` what changed (and `sync`, when it asked), after what it was being sent. */
  function push(ws: HomeSocket, sync?: number): Promise<void> {
    const next = (queues.get(ws) ?? Promise.resolve()).then(() => pushNow(ws, sync));
    queues.set(ws, next);
    return next;
  }

  /** The push itself: a view, its differences; an expired pass closes the socket. */
  async function pushNow(ws: HomeSocket, sync?: number) {
    if (!sockets.has(ws)) return;
    const { pass, publicUrl } = ws.data;
    if (pass.exp <= now()) return ws.close(EXPIRED, "Acesso vencido");
    let v: HomeView;
    try {
      counts.views++;
      v = await view(pass, publicUrl);
    } catch (err) {
      log.error("home feed failed", { err });
      if (sync !== undefined) ws.send(JSON.stringify({ sync }));
      return;
    }
    if (!sockets.has(ws)) return;
    const { message, after } = diff(v, sockets.get(ws) ?? null);
    sockets.set(ws, after);
    if (sync !== undefined) message.sync = sync;
    if (Object.keys(message).length) {
      counts.pushes++;
      ws.send(JSON.stringify(message));
    }
  }

  /** Everyone's push, one tick at a time (a nudge during one makes another right after). */
  function tick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = Promise.all([...sockets.keys()].map((ws) => push(ws))).then(() => {
      running = null;
      if (again) {
        again = false;
        void tick();
      }
    });
    return running;
  }

  function nudge() {
    generation++;
    if (!sockets.size || soon) return;
    soon = setTimeout(() => {
      soon = null;
      void tick();
    }, soonMs);
  }

  function start() {
    ticker ??= setInterval(() => void tick(), tickMs);
  }
  function stop() {
    if (sockets.size) return;
    if (ticker) clearInterval(ticker);
    if (soon) clearTimeout(soon);
    ticker = soon = null;
  }

  return {
    counts,
    nudge,
    /** Pushes to everyone now (tests). */
    tick,
    get size() {
      return sockets.size;
    },

    /**
     * `make` shared by whoever asks while it's being made: the library's walk, the same for everyone, once for all the
     * views of a tick. Never one finished before (the builders write their status meanwhile) or begun before a nudge.
     */
    shared<T>(make: () => Promise<T>): () => Promise<T> {
      let going: { generation: number; value: Promise<T> } | null = null;
      return () => {
        if (going && going.generation === generation) return going.value;
        counts.walks++;
        const value = make();
        const mine = (going = { generation, value });
        const done = () => {
          if (going === mine) going = null;
        };
        value.then(done, done);
        return value;
      };
    },

    open(ws: HomeSocket) {
      sockets.set(ws, null);
      connect?.(ws.data.pass);
      start();
      void push(ws);
      // (the others see them arrive)
      nudge();
    },

    /** `{ sync: n }`: a fresh look, now, answered with `sync: n`. Anything else is ignored. */
    message(ws: HomeSocket, raw: string | Buffer) {
      let sync: unknown;
      try {
        sync = (JSON.parse(String(raw)) as { sync?: unknown })?.sync;
      } catch {
        return;
      }
      if (!Number.isSafeInteger(sync)) return;
      generation++;
      void push(ws, sync as number);
    },

    close(ws: HomeSocket) {
      if (!sockets.delete(ws)) return;
      queues.delete(ws);
      disconnect?.(ws.data.pass);
      nudge();
      stop();
    },
  };
}

export type HomeFeed = ReturnType<typeof createHomeFeed>;
