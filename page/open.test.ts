import { expect, test } from "bun:test";
import { openRequest } from "./open";

const PUBLIC = "https://bt3.exemplo.com";

test("only our own pages are opened outside", () => {
  expect(openRequest({ t: "cordplay:open", path: "/p/abc.DEF-1_2/ps2/slus-21678/game/" }, PUBLIC)).toBe(`${PUBLIC}/p/abc.DEF-1_2/ps2/slus-21678/game/`);
  expect(openRequest({ t: "cordplay:open", path: "/p/abc/" }, PUBLIC)).toBe(`${PUBLIC}/p/abc/`);
  for (const bad of [
    { t: "cordplay:open", path: "//evil.com/p/x/" },
    { t: "cordplay:open", path: "/p/abc/../../x/" },
    { t: "cordplay:open", path: "/p/abc/ps2/../bt3/" },
    { t: "cordplay:open", path: "https://evil.com/p/abc/" },
    { t: "cordplay:open" },
    { t: "outro", path: "/p/abc/" },
    "cordplay:open",
    null,
  ])
    expect(openRequest(bad, PUBLIC)).toBeNull();
  expect(openRequest({ t: "cordplay:open", path: "/p/abc/" }, "")).toBeNull();
});

test("player 2's page opens outside too, with its room and nothing else", () => {
  const watch = "/p/abc/ps2/slus-21678/watch/?room=XC7WWC";
  expect(openRequest({ t: "cordplay:open", path: watch }, PUBLIC)).toBe(PUBLIC + watch);
  // (only watching: from the guest's page, and the library opened straight into it)
  for (const path of [`${watch}&watch=1`, "/p/abc/?play=ps2%2Fslus-21678&join=XC7WWC&watch=1"]) expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBe(PUBLIC + path);
  for (const path of ["/p/abc/ps2/slus-21678/watch/?room=XC7WWC&x=1", "/p/abc/ps2/slus-21678/watch/?room=../x", "/p/abc/ps2/slus-21678/game/?room=XC7WWC"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});

test("BT3's port opens outside too (to play smoother than in Discord), the old homebrew player doesn't", () => {
  expect(openRequest({ t: "cordplay:open", path: "/p/abc/bt3/game/" }, PUBLIC)).toBe(PUBLIC + "/p/abc/bt3/game/");
  for (const path of ["/p/abc/play/?g=tetra&p=GB&t=Tetra", "/p/abc/play//evil.com"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});

test("the library opened straight into a game (where to play: the browser), with a friend's room or a new one", () => {
  for (const path of ["/p/abc/?play=bt3", "/p/abc/?play=ps2%2Fslus-21678", "/p/abc/?play=bt3&join=QRST", "/p/abc/?play=ps2%2Fslus-21678&join=XC7WWC", "/p/abc/?play=ps2%2Fslus-21678&online=1"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBe(PUBLIC + path);
  for (const path of ["/p/abc/?play=evil", "/p/abc/?play=ps2%2F..%2Fx", "/p/abc/?play=bt3&join=<x>", "/p/abc/?play=bt3&next=//evil.com"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});

test("another copy of a game (its id: the serial, -2, -3…) opens like the first", () => {
  for (const path of ["/p/abc/?play=ps2%2Fslus-21678-2", "/p/abc/?play=ps2%2Fslus-21678-12&join=XC7WWC", "/p/abc/ps2/slus-21678-2/game/", "/p/abc/ps2/slus-21678-2/watch/?room=XC7WWC"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBe(PUBLIC + path);
  for (const path of ["/p/abc/?play=ps2%2Fslus-21678-123", "/p/abc/ps2/slus-21678-/game/", "/p/abc/ps2/slus-21678-x/game/"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});

test("a PS2 game's versão rápida opens outside too: its page, and the library straight into it", () => {
  for (const path of ["/p/abc/ps2/scus-97399/fast/", "/p/abc/?play=ps2%2Fscus-97399&fast=1", "/p/abc/?play=ps2%2Fscus-97399&fast=1&online=1"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBe(PUBLIC + path);
  for (const path of ["/p/abc/ps2/scus-97399/fast/ps2web.wasm", "/p/abc/?play=ps2%2Fscus-97399&fast=2", "/p/abc/?play=ps2%2Fscus-97399&online=1&fast=1", "/p/abc/?play=ps2%2Fscus-97399&fast=1&join=ABCDEF"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});
