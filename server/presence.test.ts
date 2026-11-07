import { expect, test } from "bun:test";
import { gameFrom, Presence, QUIET_MS } from "./presence";

const ana = { id: "1", name: "Ana", exp: 0, call: "555" };
const bia = { id: "2", name: "Bia", exp: 0 };

test("a game's page by its path: PS2 (emulator, fast, watching), and a port", () => {
  expect(gameFrom("ps2/slus-21678/game/")).toEqual({ key: "ps2/slus-21678", watch: false });
  expect(gameFrom("ps2/slus-21678/fast/?online=host")).toEqual({ key: "ps2/slus-21678", watch: false });
  expect(gameFrom("ps2/slus-21678/watch/?room=ABCDEF")).toEqual({ key: "ps2/slus-21678", watch: false });
  expect(gameFrom("ps2/slus-21678/watch/?room=ABCDEF&watch=1")).toEqual({ key: "ps2/slus-21678", watch: true });
  expect(gameFrom("bt3/game/")).toEqual({ key: "bt3", watch: false });
  for (const bad of ["", "games", "ps2/../game/", "play/?g=tetra&p=GB", "cover/bt3"]) expect(gameFrom(bad)).toBeNull();
});

test("the library and a game's page; others only, and gone after a quiet while", () => {
  let t = 1000;
  const p = new Presence(() => t);
  p.library(ana);
  p.playing(bia, { key: "bt3", title: "BT3", watch: false });
  expect(p.others("1")).toEqual([{ id: "2", name: "Bia", call: undefined, game: { key: "bt3", title: "BT3", watch: false, at: 1000 }, at: 1000 }]);
  expect(p.others("2").map((x) => [x.name, x.call, x.game])).toEqual([["Ana", "555", null]]);
  // the library polling meanwhile keeps the game while its page still beats; then the game is gone, the person stays
  t += QUIET_MS - 1;
  p.library(bia);
  expect(p.others("1")[0]!.game?.key).toBe("bt3");
  t += 2;
  p.library(bia);
  expect(p.others("1")[0]!.game).toBeNull();
  // the page closing says so at once
  p.playing(bia, { key: "bt3", title: "BT3", watch: false });
  p.playing(bia, null);
  expect(p.others("1")[0]!.game).toBeNull();
  // nobody heard from: gone
  t += QUIET_MS + 1;
  expect(p.others("1")).toEqual([]);
});
