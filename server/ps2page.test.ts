import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchTabStation, SWAPS } from "./ps2page";

const page = readFileSync(join(import.meta.dir, "fixtures", "tabstation-index.html"), "utf8").replace(/\r\n/g, "\n");
const out = patchTabStation(page, "God of War <II>");

test("the game's name, no service worker, and app.js held back for ps2play.js", () => {
  expect(out).toContain("<title>God of War &lt;II&gt; · CordPlay</title>");
  expect(out).not.toContain('<script src="coi-serviceworker.js">');
  expect(out).not.toMatch(/<script src="app\.js[^"]*" defer><\/script>/);
  expect(out).toMatch(/<script data-cp-app="app\.js\?v=[\w]+"><\/script>/);
  expect(out).toContain('<script src="../../../ps2play.js"></script>');
  // ps2play.js comes before app.js would have
  expect(out.indexOf("ps2play.js")).toBeLessThan(out.indexOf("data-cp-app"));
});

test("the license and the source, at the bottom", () => {
  expect(out).toContain('href="https://github.com/TabStationToo/TabStationToo"');
  expect(out).toContain('href="COPYING.GPLv3"');
  expect(out).toContain("GPL-3.0");
});

test("fails loudly when a piece is missing", () => {
  for (const { from } of SWAPS) {
    const broken = page.replace(from, "");
    expect(() => patchTabStation(broken, "x")).toThrow("tabstation index.html: não achei");
  }
});

test("a name with $ patterns is taken as written", () => {
  for (const name of ["$$'", "$'", "$&", "$1 Game $`"]) {
    const html = patchTabStation(page, name);
    const xml = name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    expect(html).toContain(`<title>${xml} · CordPlay</title>`);
  }
});
