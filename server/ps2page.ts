/**
 * TabStationToo's page (emulator/ps2/index.html) as the PS2 games' page, adjusted when it's served: the game's name,
 * no service worker (the server sends the isolation headers itself), and app.js held back so page/ps2play.ts can
 * first boot it on our BIOS and disc, put the person's memory card in slot 1 and draw it in our design; plus the
 * license line the GPL asks for. Each swap must find its text: a new version upstream fails here, loudly.
 */

interface Swap {
  from: string | RegExp;
  to: string;
}

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LICENSE = `<p id="cp-license">Emulador: <a href="https://github.com/TabStationToo/TabStationToo" target="_blank" rel="noopener">TabStationToo</a> (PCSX2, GPL-3.0), <a href="https://github.com/victorgabrieldeon/TabStationToo/releases/tag/hypeplay-hd-1" target="_blank" rel="noopener">modificado</a> · <a href="COPYING.GPLv3" target="_blank">licença</a></p>`;

export const SWAPS: Swap[] = [
  { from: "<title>TabStationToo</title>", to: "<title>{name} · HypePlay</title>" },
  { from: '<script src="coi-serviceworker.js"></script>', to: "" },
  // ps2play.js loads it once the card and the boot address are in place
  { from: /<script src="(app\.js\?v=\w+)" defer><\/script>/, to: '<script src="../../../ps2play.js"></script>\n<script data-cp-app="$1"></script>' },
  { from: "</body>", to: `${LICENSE}\n</body>` },
];

export function patchTabStation(html: string, name: string): string {
  let out = html.replace(/\r\n/g, "\n");
  for (const { from, to } of SWAPS) {
    const found = typeof from === "string" ? out.split(from).length - 1 : (out.match(new RegExp(from, "g")) ?? []).length;
    if (found !== 1) throw new Error(`tabstation index.html: não achei ${found ? "um só" : "o"} trecho ${String(from)} (o TabStationToo mudou? revise server/ps2page.ts)`);
    // (replacer functions: a "$" in the game's name or in the page is text, not a replacement pattern)
    const value = to.replace("{name}", () => xml(name));
    out = typeof from === "string" ? out.replace(from, () => value) : out.replace(from, (...m: string[]) => value.replace("$1", () => m[1]!));
  }
  return out;
}
