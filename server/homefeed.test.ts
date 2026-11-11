import { expect, test } from "bun:test";
import { createHomeFeed, diff, etagOf, EXPIRED, type HomeSocket, type HomeView, unchanged } from "./homefeed";
import type { Pass } from "./pass";

/** A game as the views carry it (the catalog's entries have more). */
type Game = HomeView["games"][number] & Record<string, unknown>;
const ana: Pass = { id: "1", name: "Ana", exp: Infinity };
const bia: Pass = { id: "2", name: "Bia", exp: Infinity };

const home = (over: Partial<HomeView> = {}): HomeView => ({
  me: "Ana",
  last: null,
  publicUrl: "",
  games: [
    { key: "ps2/a", status: { state: "ready" } },
    { key: "ps2/b", status: { state: "empty" } },
  ] as Game[],
  people: [],
  social: null,
  ...over,
});

function socket(pass: Pass) {
  const got: Record<string, unknown>[] = [];
  const ws = {
    data: { pass, publicUrl: "" },
    closed: null as number | null,
    send: (m: string) => void got.push(JSON.parse(m)),
    close(code?: number) {
      this.closed = code ?? 1000;
    },
  };
  return { ws: ws as HomeSocket & typeof ws, got };
}

const settle = () => Bun.sleep(5);

test("the ETag follows the JSON; If-None-Match is read as a list, weak or not, and ?v= too", () => {
  const tag = etagOf('{"a":1}');
  expect(tag).toMatch(/^"[0-9a-z]+"$/);
  expect(etagOf('{"a":1}')).toBe(tag);
  expect(etagOf('{"a":2}')).not.toBe(tag);
  const req = (h?: string) => new Request("http://x/", h ? { headers: { "if-none-match": h } } : {});
  expect(unchanged(req(), tag)).toBe(false);
  expect(unchanged(req(tag), tag)).toBe(true);
  expect(unchanged(req(`"old", W/${tag}`), tag)).toBe(true);
  expect(unchanged(req('"old"'), tag)).toBe(false);
  expect(unchanged(req("*"), tag)).toBe(true);
  // (the page's way: ?v=)
  expect(unchanged(new Request(`http://x/games?v=${encodeURIComponent(tag)}`), tag)).toBe(true);
  expect(unchanged(new Request("http://x/games?v=%22old%22"), tag)).toBe(false);
});

test("diff: everything the first time, then only what changed, a game alone when the library's games are the same", () => {
  const first = diff(home(), null);
  expect(Object.keys(first.message).sort()).toEqual(["games", "last", "me", "people", "publicUrl", "social"]);
  // nothing changed: nothing to send
  expect(diff(home(), first.after).message).toEqual({});
  // one game's progress: that game only
  const going = home({ games: [{ key: "ps2/a", status: { state: "ready" } }, { key: "ps2/b", status: { state: "uploading", received: 5 } }] as Game[] });
  const second = diff(going, first.after);
  expect(second.message).toEqual({ game: [{ key: "ps2/b", status: { state: "uploading", received: 5 } }] });
  // a game more (or fewer, or another order): the library whole
  const more = home({ games: [...going.games, { key: "ps2/c" }] });
  expect(Object.keys(diff(more, second.after).message)).toEqual(["games"]);
  // someone around, a friend's request, a new last game: those sections
  const m = diff(home({ games: going.games, people: [{ id: "2" }], social: { incoming: [] }, last: "ps2/a" }), second.after).message;
  expect(m).toEqual({ me: "Ana", last: "ps2/a", publicUrl: "", people: [{ id: "2" }], social: { incoming: [] } });
});

test("open: the whole home at once, then a tick sends each socket only its own changes", async () => {
  let views: Record<string, HomeView> = { "1": home(), "2": home({ me: "Bia" }) };
  const seen: string[] = [];
  const feed = createHomeFeed({
    view: async (p) => views[p.id]!,
    connect: (p) => seen.push(`+${p.name}`),
    disconnect: (p) => seen.push(`-${p.name}`),
    tickMs: 60_000,
  });
  const a = socket(ana), b = socket(bia);
  feed.open(a.ws);
  feed.open(b.ws);
  await settle();
  expect(a.got).toHaveLength(1);
  expect(a.got[0]!.me).toBe("Ana");
  expect(b.got[0]!.me).toBe("Bia");
  expect(seen).toEqual(["+Ana", "+Bia"]);
  views = { ...views, "2": home({ me: "Bia", people: [{ id: "1" }] }) };
  await feed.tick();
  expect(a.got).toHaveLength(1);
  expect(b.got.at(-1)).toEqual({ people: [{ id: "1" }] });
  feed.close(a.ws);
  feed.close(a.ws);
  expect(seen).toEqual(["+Ana", "+Bia", "-Ana"]);
  feed.close(b.ws);
  expect(feed.size).toBe(0);
});

test("sync: answered at once, even with nothing new, and with a fresh walk", async () => {
  let walked = 0;
  const feed = createHomeFeed({ view: async () => home(), tickMs: 60_000 });
  const walk = feed.shared(async () => ++walked);
  const a = socket(ana);
  feed.open(a.ws);
  await settle();
  await walk();
  feed.message(a.ws, JSON.stringify({ sync: 7 }));
  await settle();
  expect(a.got.at(-1)).toEqual({ sync: 7 });
  expect(await walk()).toBe(2);
  // anything else is ignored
  for (const junk of ["nope", '{"sync":"x"}', "{}"]) feed.message(a.ws, junk);
  await settle();
  expect(a.got).toHaveLength(2);
  feed.close(a.ws);
});

test("shared: one walk for the views made at once; never a finished one, nor one begun before a nudge", async () => {
  const feed = createHomeFeed({ view: async () => home() });
  let n = 0;
  const releases: (() => void)[] = [];
  const release = () => releases.splice(0).forEach((r) => r());
  const walk = feed.shared(() => new Promise<number>((ok) => (n++, releases.push(() => ok(n)))));
  const [x, y] = [walk(), walk()];
  expect(n).toBe(1);
  release();
  expect(await x).toBe(1);
  expect(await y).toBe(1);
  // finished: the next look walks again
  const z = walk();
  expect(n).toBe(2);
  // a nudge while it goes: the next asks anew
  feed.nudge();
  walk();
  expect(n).toBe(3);
  release();
  await z;
});

test("a nudge pushes soon, a tick runs every tickMs while a home is open, and stops with the last one", async () => {
  let people: unknown[] = [];
  const feed = createHomeFeed({ view: async () => home({ people }), tickMs: 30, soonMs: 5 });
  const a = socket(ana);
  feed.open(a.ws);
  await settle();
  people = [{ id: "2" }];
  feed.nudge();
  await Bun.sleep(20);
  expect(a.got.at(-1)).toEqual({ people: [{ id: "2" }] });
  people = [];
  await Bun.sleep(60);
  expect(a.got.at(-1)).toEqual({ people: [] });
  feed.close(a.ws);
  const views = feed.counts.views;
  await Bun.sleep(80);
  expect(feed.counts.views).toBe(views);
});

test("an expired pass closes its socket (the page's poll then gets the 403)", async () => {
  let t = 1000;
  const feed = createHomeFeed({ view: async () => home(), now: () => t, tickMs: 60_000 });
  const a = socket({ ...ana, exp: 2000 });
  feed.open(a.ws);
  await settle();
  expect(a.got).toHaveLength(1);
  t = 2000;
  await feed.tick();
  expect(a.ws.closed).toBe(EXPIRED);
  feed.close(a.ws);
});

test("a view that fails sends nothing, but a sync is still answered", async () => {
  const feed = createHomeFeed({ view: async () => Promise.reject(new Error("disk")), tickMs: 60_000 });
  const err = console.error;
  console.error = () => {};
  try {
    const a = socket(ana);
    feed.open(a.ws);
    await settle();
    expect(a.got).toEqual([]);
    feed.message(a.ws, '{"sync":1}');
    await settle();
    expect(a.got).toEqual([{ sync: 1 }]);
    feed.close(a.ws);
  } finally {
    console.error = err;
  }
});
