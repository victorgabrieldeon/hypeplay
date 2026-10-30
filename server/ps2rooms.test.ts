import { expect, test } from "bun:test";
import { GUEST_QUIET_MS, Ps2Rooms, ROOM_IDLE_MS, ROOM_LETTERS } from "./ps2rooms";

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
  expect(r.list("sles-12345")[0]).toEqual({ code, host: "Ana", since: 1_000_000, busy: false });
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

test("wait sleeps until a message arrives, or returns empty after 20 s", async () => {
  const t = fakeTime();
  const r = rooms(t);
  const code = r.create("sles-12345", ana);
  const waiting = r.wait(code, "host", 0);
  r.post(code, "host", { type: "join", from: "g1" });
  expect(await waiting).toEqual({ messages: [{ type: "join", from: "g1" }], next: 1 });
  const empty = r.wait(code, "host", 1);
  t.advance(20_000);
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
  t.advance(GUEST_QUIET_MS + 1);
  expect(r.list("sles-12345")[0]!.busy).toBe(false);
});
