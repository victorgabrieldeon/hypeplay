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
    { t: "cordplay:open", path: "/p/abc/bt3/game/" },
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
  for (const path of ["/p/abc/ps2/slus-21678/watch/?room=XC7WWC&x=1", "/p/abc/ps2/slus-21678/watch/?room=../x", "/p/abc/ps2/slus-21678/game/?room=XC7WWC"])
    expect(openRequest({ t: "cordplay:open", path }, PUBLIC)).toBeNull();
});
