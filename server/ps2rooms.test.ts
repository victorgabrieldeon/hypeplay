import { expect, test } from "bun:test";
import { GUEST_QUIET_MS, HOST_QUIET_MS, Ps2Rooms, ROOM_IDLE_MS, ROOM_LETTERS, WAIT_MS } from "./ps2rooms";

const ana = { id: "42", name: "Ana" };

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const setTimer = ((fn: () => void, ms: number) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return t;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((t: unknown) => {
    const i = timers.indexOf(t as (typeof timers)[number]);
    if (i >= 0) timers.splice(i, 1);
  }) as unknown as typeof clearTimeout;
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { now: () => now, setTimer, clearTimer, advance };
}

const rooms = (t = fakeTime(), seq = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2]) => {
  let i = 0;
  return new Ps2Rooms(t.now, () => seq[i++ % seq.length]!, t.setTimer, t.clearTimer);
};

test("a room gets a fresh 6-letter code and is listed for its game only", () => {
  const t = fakeTime();
  const first = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2];
  // the second room draws the first one's code again, then another
  const r = rooms(t, [...first, ...first, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
  const code = r.create("sles-12345", ana);
  expect(code).toMatch(new RegExp(`^[${ROOM_LETTERS}]{6}$`));
  expect(r.create("sles-12345", ana)).not.toBe(code);
  expect(r.list("sles-12345").map((x) => x.code)).toContain(code);
  expect(r.list("sles-12345")[0]).toEqual({ code, host: "Ana", since: 1_000_000, busy: false, watchers: 0 });
  expect(r.list("scus-97481")).toEqual([]);
});

test("a message reaches the right inbox; wait returns at once when there is one", async () => {
  const r = rooms();
  const code = r.create("sles-12345", ana);
  expect(r.post(code, "host", { type: "join", from: "g1" })).toBe(true);
  expect(r.post("ZZZZZZ", "host", { type: "join" })).toBe(false);
  expect(await r.wait(code, "host", 0)).toEqual({ messages: [{ type: "join", from: "g1" }], next: 1 });
  expect(r.post(code, "g1", { type: "offer", sdp: "x" })).toBe(true);
  expect(await r.wait(code, "g1", 0)).toEqual({ messages: [{ type: "offer", sdp: "x" }], next: 1 });
});

test("wait sleeps until a message arrives, or returns empty after WAIT_MS", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  const waiting = r.wait(code, "host", 0);
  r.post(code, "host", { type: "join", from: "g1" });
  expect(await waiting).toEqual({ messages: [{ type: "join", from: "g1" }], next: 1 });
  const empty = r.wait(code, "host", 1);
  t.advance(WAIT_MS);
  expect(await empty).toEqual({ messages: [], next: 1 });
});

test("an idle room goes after an hour; wait on it is null", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  t.advance(ROOM_IDLE_MS + 1);
  expect(await r.wait(code, "host", 0)).toBeNull();
  expect(r.list("sles-12345")).toEqual([]);
});

test("busy once a guest joined, free again when it left or went quiet", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  r.post(code, "host", { type: "join", from: "g1" });
  expect(r.list("sles-12345")[0]!.busy).toBe(true);
  r.post(code, "host", { type: "bye", from: "g1" });
  expect(r.list("sles-12345")[0]!.busy).toBe(false);

  r.post(code, "host", { type: "join", from: "g2" });
  expect(r.list("sles-12345")[0]!.busy).toBe(true);
  t.advance(GUEST_QUIET_MS - 1_000);
  void r.wait(code, "host", 9, 1); // (the host keeps polling)
  t.advance(2_000);
  expect(r.list("sles-12345")[0]!.busy).toBe(false);
});

test("a long-poll ends before Bun's 10 s idle timeout cuts the request", () => {
  expect(WAIT_MS).toBeLessThan(10_000);
});

test("a playing guest's heartbeat keeps the room busy, and isn't kept in the host's inbox", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  r.post(code, "host", { type: "join", from: "g1" });
  for (let i = 0; i < 4; i++) {
    t.advance(GUEST_QUIET_MS - 5_000);
    void r.wait(code, "host", 1, 1); // the host keeps polling
    expect(r.post(code, "host", { type: "here", from: "g1" })).toBe(true);
  }
  expect(r.list("sles-12345")[0]!.busy).toBe(true);
  expect(await r.wait(code, "host", 0, 1)).toEqual({ messages: [{ type: "join", from: "g1" }], next: 1 });
});

test("a room whose host stopped polling is gone", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  t.advance(HOST_QUIET_MS - 1_000);
  void r.wait(code, "host", 0, 1);
  t.advance(HOST_QUIET_MS - 1_000);
  expect(r.list("sles-12345").map((x) => x.code)).toEqual([code]);
  t.advance(2_000);
  expect(r.list("sles-12345")).toEqual([]);
  expect(r.post(code, "host", { type: "join", from: "g1" })).toBe(false);
});

test("only its host closes a room", async () => {
  const r = rooms();
  const code = r.create("sles-12345", ana);
  expect(r.close(code, "43")).toBe(false);
  expect(r.close(code, "42")).toBe(true);
  expect(r.list("sles-12345")).toEqual([]);
  expect(await r.wait(code, "g1", 0)).toBeNull();
});

test("who may use a room's relay: its host, and a guest that joined and hasn't left, as player or watcher", () => {
  const r = rooms();
  const code = r.create("sles-12345", ana);
  expect(r.hostOf(code)).toBe("42");
  expect(r.hostOf("ZZZZZZ")).toBeNull();
  expect(r.guestOf(code, "g1")).toBeNull();
  r.post(code, "host", { type: "join", from: "g1" });
  r.post(code, "host", { type: "join", from: "w1", watch: true });
  expect(r.guestOf(code, "g1")).toBe("player");
  expect(r.guestOf(code, "w1")).toBe("watch");
  expect(r.guestOf(code, "g2")).toBeNull();
  r.post(code, "host", { type: "bye", from: "g1" });
  r.post(code, "host", { type: "bye", from: "w1" });
  expect(r.guestOf(code, "g1")).toBeNull();
  expect(r.guestOf(code, "w1")).toBeNull();
  expect(r.guestOf("ZZZZZZ", "g1")).toBeNull();
});

test("watchers are counted but never make the room busy; byHost finds a person's rooms", () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  r.post(code, "host", { type: "join", from: "w1", watch: true });
  r.post(code, "host", { type: "join", from: "w2", watch: true });
  expect(r.list("sles-12345")[0]).toMatchObject({ busy: false, watchers: 2 });
  r.post(code, "host", { type: "join", from: "g1" });
  expect(r.byHost("42")).toEqual([{ code, host: "Ana", since: 1_000_000, busy: true, watchers: 2, game: "sles-12345" }]);
  expect(r.byHost("7")).toEqual([]);
  // one watcher keeps saying "here"; the other went quiet
  t.advance(GUEST_QUIET_MS - 1000);
  void r.wait(code, "host", 0, 1);
  r.post(code, "host", { type: "here", from: "w1" });
  t.advance(2000);
  void r.wait(code, "host", 0, 1);
  expect(r.list("sles-12345")[0]).toMatchObject({ busy: false, watchers: 1 });
});
