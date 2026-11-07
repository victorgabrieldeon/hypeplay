import { expect, test } from "bun:test";
import { CARD_BYTES, createCardSync, heldByOtherTab, type CardStore } from "./cardsync";

const card = (fill: number) => new Uint8Array(CARD_BYTES).fill(fill);

/** The server's save, and what it was sent; `fail` answers with that status (or throws for "net"). */
function fakeServer(start: Uint8Array | null) {
  let saved = start;
  const log: string[] = [];
  let fail: (number | "net")[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    log.push(method);
    const f = fail.shift();
    if (f === "net") throw new TypeError("network");
    if (f) return new Response("no", { status: f });
    if (method === "PUT") {
      saved = new Uint8Array(init!.body as Uint8Array);
      return new Response(null, { status: 204 });
    }
    return saved ? new Response(saved as Uint8Array<ArrayBuffer>) : new Response("Sem save", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, log, get saved() { return saved; }, failNext: (...f: (number | "net")[]) => (fail = f) };
}

function fakeStore(dirty: Uint8Array | null = null): CardStore & { dirty: Uint8Array | null } {
  return {
    dirty,
    async getDirty() { return this.dirty; },
    async setDirty(b) { this.dirty = b; },
  };
}

const instant = { wait: async () => {} };

test("a card left unsent last time goes up first, and is the one the game gets", async () => {
  const server = fakeServer(card(1));
  const store = fakeStore(card(9));
  const sync = createCardSync({ fetch: server.fetch, store, guard: () => {}, ...instant });
  const start = await sync.start();
  expect(start).toMatchObject({ saving: true });
  expect(start.seed![0]).toBe(9);
  expect(server.log).toEqual(["PUT"]);
  expect(server.saved![0]).toBe(9);
  expect(store.dirty).toBeNull();
});

test("no save on the server (404) is a blank card; a save is that save", async () => {
  const none = await createCardSync({ fetch: fakeServer(null).fetch, store: fakeStore(), guard: () => {}, ...instant }).start();
  expect(none.saving).toBe(true);
  expect(none.seed![0]).toBe(0xff);
  const some = await createCardSync({ fetch: fakeServer(card(3)).fetch, store: fakeStore(), guard: () => {}, ...instant }).start();
  expect(some.seed![0]).toBe(3);
});

test("a download that keeps failing is never taken as no save: nothing is seeded and nothing is sent", async () => {
  const server = fakeServer(card(3));
  server.failNext(502, "net", 500);
  const sync = createCardSync({ fetch: server.fetch, store: fakeStore(), guard: () => {}, ...instant });
  const start = await sync.start();
  expect(start).toEqual({ seed: null, saving: false });
  await sync.saved(card(4));
  expect(server.saved![0]).toBe(3);
  // and a brief failure is retried
  const flaky = fakeServer(card(3));
  flaky.failNext("net");
  expect((await createCardSync({ fetch: flaky.fetch, store: fakeStore(), guard: () => {}, ...instant }).start()).seed![0]).toBe(3);
});

test("a save is kept here before it's sent, retried until it goes through, with the page held meanwhile", async () => {
  const server = fakeServer(null);
  const store = fakeStore();
  const guards: boolean[] = [];
  const sync = createCardSync({ fetch: server.fetch, store, guard: (on) => guards.push(on), ...instant });
  await sync.start();
  server.failNext("net", 503);
  const kept = sync.saved(card(5));
  expect(store.dirty?.[0]).toBe(5);
  await kept;
  expect(server.log.filter((m) => m === "PUT")).toHaveLength(3);
  expect(server.saved![0]).toBe(5);
  expect(store.dirty).toBeNull();
  expect(guards).toEqual([true, false]);
});

test("saves that pile up send only the latest, one at a time", async () => {
  const server = fakeServer(null);
  let release = () => {};
  const slow = (async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") await new Promise<void>((ok) => (release = ok));
    return server.fetch(url, init);
  }) as unknown as typeof globalThis.fetch;
  const sync = createCardSync({ fetch: slow, store: fakeStore(), guard: () => {}, ...instant });
  await createCardSync({ fetch: server.fetch, store: fakeStore(), guard: () => {}, ...instant }).start();
  const a = sync.saved(card(1));
  await Bun.sleep(1);
  const b = sync.saved(card(2));
  const c = sync.saved(card(3));
  release();
  await Bun.sleep(1);
  release();
  await Promise.all([a, b, c]);
  expect(server.log.filter((m) => m === "PUT")).toHaveLength(2);
  expect(server.saved![0]).toBe(3);
});

test("another tab holding the cards", () => {
  expect(heldByOtherTab({ held: [{ name: "tabstationtoo-memcards" }] })).toBe(true);
  expect(heldByOtherTab({ held: [{ name: "x" }], pending: [] })).toBe(false);
  expect(heldByOtherTab(null)).toBe(false);
});

test("a save that comes while the one before is being cleared still goes up this session", async () => {
  const server = fakeServer(card(1));
  const store = fakeStore();
  const sync = createCardSync({ fetch: server.fetch, store, guard: () => {}, ...instant });
  await sync.start();
  let late: Promise<void> | null = null;
  const setDirty = store.setDirty.bind(store);
  store.setDirty = async (b) => {
    // the game saves again just as the first upload is done and its unsent copy is being cleared
    if (!b && !late) late = sync.saved(card(3));
    await setDirty(b);
  };
  await sync.saved(card(2));
  await late;
  expect(server.saved![0]).toBe(3);
  expect(server.log.filter((m) => m === "PUT").length).toBe(2);
});
