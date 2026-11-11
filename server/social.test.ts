import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAT_GAP_MS, createSocial, INVITE_TTL_MS } from "./social";

const root = mkdtempSync(join(tmpdir(), "cordplay-social-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const clock = { t: 1_000_000 };
  const dir = join(root, String(n++));
  return { s: createSocial(dir, () => clock.t), clock, dir };
};
const ana = { id: "1", name: "Ana" };
const bia = { id: "2", name: "Bia" };
const caio = { id: "3", name: "Caio" };
const bt3 = { key: "bt3", title: "BT3", watch: false };

test("a request, then the other side adding back: friends on both sides; removing clears both", () => {
  const { s } = fresh();
  for (const p of [ana, bia]) s.seen(p);
  expect(s.add("1", "1")).toBe("bad");
  expect(s.add("1", "9")).toBe("bad"); // (nobody by that id)
  expect(s.add("1", "2")).toBe("sent");
  expect(s.add("1", "2")).toBe("already");
  expect(s.view("2", () => true)!.incoming).toEqual([{ id: "1", name: "Ana" }]);
  expect(s.profile("2", "1")!.relation).toBe("incoming");
  expect(s.add("2", "1")).toBe("friends");
  expect(s.view("1", () => false)!.friends.map((f) => [f.name, f.status])).toEqual([["Bia", "offline"]]);
  expect(s.view("2", () => true)!.friends.map((f) => [f.name, f.status])).toEqual([["Ana", "online"]]);
  expect(s.view("2", () => true)!.incoming).toEqual([]);
  expect(s.remove("2", "1")).toBe(true);
  expect(s.view("1", () => true)!.friends).toEqual([]);
  expect(s.profile("1", "2")!.relation).toBe("none");
});

test("hours: the time between beats of the same game, not across a gap, a new game, or while watching", () => {
  const { s, clock } = fresh();
  s.beat(ana, bt3);
  clock.t += 15_000;
  s.beat(ana, bt3);
  clock.t += 15_000;
  s.beat(ana, bt3);
  clock.t += BEAT_GAP_MS + 1; // (the page was closed meanwhile: a new sitting)
  s.beat(ana, bt3);
  clock.t += 15_000;
  s.beat(ana, { ...bt3, watch: true });
  clock.t += 15_000;
  s.beat(ana, bt3);
  const p = s.profile("1", "1")!;
  expect(p.games).toEqual([{ key: "bt3", title: "BT3", ms: 30_000, sessions: 3, last: clock.t }]);
  expect(p.total).toBe(30_000);
  expect(p.recent.length).toBe(3);
  expect(p.recent.at(-1)!.end - p.recent.at(-1)!.start).toBe(30_000);
});

test("invites: friends only, not to someone busy, one per sender; accepting tells the sender; they expire", () => {
  const { s, clock } = fresh();
  for (const p of [ana, bia, caio]) s.seen(p);
  expect(s.invite("1", "2", { key: "bt3", title: "BT3" })).toMatchObject({ ok: false, status: 403 });
  s.add("1", "2");
  s.add("2", "1");
  expect(s.invite("1", "2", { key: "bt3", title: "BT3", code: "KRTZ" })).toEqual({ ok: true });
  expect(s.invite("1", "2", { key: "bt3", title: "BT3", code: "KRTZ" })).toEqual({ ok: true });
  const [inv, ...more] = s.view("2", () => true)!.invites;
  expect(more).toEqual([]);
  expect(inv).toMatchObject({ from: "1", name: "Ana", key: "bt3", code: "KRTZ", kind: "invite" });
  expect(s.answer("2", inv!.id, true)?.code).toBe("KRTZ");
  expect(s.view("2", () => true)!.invites).toEqual([]);
  expect(s.view("1", () => true)!.invites).toMatchObject([{ from: "2", name: "Bia", kind: "accepted" }]);
  clock.t += INVITE_TTL_MS;
  expect(s.view("1", () => true)!.invites).toEqual([]);
  s.setStatus("2", { status: "busy" });
  expect(s.invite("1", "2", { key: "bt3", title: "BT3" })).toMatchObject({ ok: false, status: 409 });
});

test("invisible: offline to friends, with no last seen and no feed; the note is cut", () => {
  const { s } = fresh();
  for (const p of [ana, bia]) s.seen(p);
  s.add("1", "2");
  s.add("2", "1");
  s.beat(bia, bt3);
  expect(s.view("1", () => true)!.feed.map((f) => f.name)).toEqual(["Bia"]);
  expect(s.setStatus("2", { status: "nope" })).toBe(false);
  expect(s.setStatus("2", { status: "invisible", note: "x".repeat(200) })).toBe(true);
  const f = s.view("1", () => true)!;
  expect(f.friends[0]).toMatchObject({ status: "offline", seen: null });
  expect(f.feed).toEqual([]);
  expect(s.profile("2", "2")!.note.length).toBe(80);
  // nothing in their profile says they're playing now, nor in someone else's "played with"
  s.beat(bia, bt3);
  s.beat(ana, bt3, ["2"]);
  expect(s.profile("1", "2")!.recent).toEqual([]);
  expect(s.profile("1", "2")!.games[0]!.last).toBe(0);
  expect(s.profile("2", "1")!.with).toEqual([]);
});

test("someone who only opened the library is kept, without anyone calling flush", async () => {
  const { s, dir } = fresh();
  s.seen(ana);
  await Bun.sleep(2100);
  expect(createSocial(dir).search("2", "an")).toEqual([{ id: "1", name: "Ana", relation: "none" }]);
});

test("the profile: games in common, mutual friends, played with; and it's all still there after a restart", async () => {
  const { s, clock, dir } = fresh();
  for (const p of [ana, bia, caio]) s.seen(p);
  for (const [a, b] of [["1", "2"], ["1", "3"], ["2", "3"]] as const) s.add(a, b), s.add(b, a);
  s.beat(ana, bt3, ["2"]);
  s.beat(bia, bt3);
  clock.t += 10_000;
  s.beat(ana, bt3);
  s.beat(bia, bt3);
  const p = s.profile("2", "1")!;
  expect(p.common).toEqual([{ key: "bt3", title: "BT3", mine: 10_000, theirs: 10_000 }]);
  expect(p.mutual).toEqual([{ id: "3", name: "Caio" }]);
  expect(p.with.map((w) => w.name)).toEqual(["Bia"]);
  expect(s.search("1", "bi")).toEqual([{ id: "2", name: "Bia", relation: "friend" }]);
  await s.flush();
  expect(createSocial(dir).profile("2", "1")!.total).toBe(10_000);
});

test("every change is written: after a restart, everyone's view and profiles are the same", async () => {
  const { s, clock, dir } = fresh();
  const outro = { key: "ps2/sles-12345", title: "Outro", watch: false };
  // (written after each step: a change that doesn't mark someone isn't hidden by a later one that does)
  const steps = [
    () => [ana, bia, caio].forEach((p) => s.seen(p)),
    () => s.add("1", "2"),
    () => s.add("2", "1"),
    () => s.add("1", "3"),
    () => s.add("3", "2"),
    () => s.setStatus("2", { status: "away", note: "já volto" }),
    () => s.beat(ana, bt3, ["2"]),
    () => ((clock.t += 15_000), s.beat(ana, bt3, ["2"])),
    () => s.beat(bia, outro),
    () => ((clock.t += 15_000), s.beat(bia, outro)),
    () => s.beat(ana, null),
    () => s.add("2", "3"),
    () => s.seen({ id: "3", name: "Caio Novo" }),
    () => s.remove("1", "3"),
  ];
  const ids = ["1", "2", "3"];
  const all = (x: typeof s) => ids.map((me) => [x.view(me, () => true), ids.map((id) => x.profile(me, id))]);
  for (const step of steps) {
    step();
    await s.flush();
    expect(all(createSocial(dir, () => clock.t))).toEqual(all(s));
  }
});
