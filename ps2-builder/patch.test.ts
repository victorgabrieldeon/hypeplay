import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK, patchShell, SWAPS } from "./patch";

// web/shell.html of ps2-web-recomp at the commit the builder pins (MIT; see fixtures/README.md).
const shell = readFileSync(join(import.meta.dir, "fixtures", "shell.html"), "utf8").replace(/\r\n/g, "\n");
const out = patchShell(shell);

test("the card comes from and goes to the server, never a blank one over a save it couldn't read", () => {
  expect(out).not.toContain("IDBFS");
  expect(out).not.toContain("FS.syncfs");
  expect(out).toContain("fetch('../save', { cache: 'no-store' })");
  expect(out).toContain("fetch('../save', { method: 'PUT', body: data })");
  // only a 404 turns saving on without a card; a failed read leaves it off
  expect(out).toContain("if (r && r.status === 404) { cardSaving = true; return; }");
  expect(out).toContain("if (!cardSaving) return Promise.resolve();");
  // one tab at a time, by the emulator's own lock
  expect(out).toContain("navigator.locks.request('tabstationtoo-memcards'");
  // a card the emulator's page left unsent goes up before the server's is read, and its database is never made here
  expect(out).toContain("get('cordplay-unsent')");
  expect(out).toContain("open.onupgradeneeded = () => open.transaction.abort();");
  expect(out.indexOf("get('cordplay-unsent')")).toBeLessThan(out.indexOf("fetch('../save', { cache: 'no-store' })"));
  expect(out).toContain("cardLoad().finally(() => Module.removeRunDependency('card'));");
  // Export / Import card are untouched, and import saves to the server through storeCard
  expect(out).toContain("link.download = 'Mcd001.ps2';");
  expect(out).toContain("storeCard(() => location.reload());");
});

test("code the build lacks goes to the server, and the emulator is offered", () => {
  expect(out).toContain("fetch('miss', { method: 'POST', body: miss[1] }).then((r) => say(r.ok)");
  expect(out).toContain('href="../game/"');
  expect(out).not.toContain("'Halted: '");
});

test("isolation missing in a frame offers the browser", () => {
  expect(out).toContain("t: 'cordplay:open', path: location.pathname");
  expect(out).toContain("Abrir no navegador");
  expect(out).not.toContain("This browser cannot run the game yet");
});

test("its own online is hidden, the element kept for its script", () => {
  expect(out).toContain('<button id="invite" class="host-only" type="button" disabled hidden style="display:none">');
  expect(out).not.toContain(">Invite</button>");
  expect(out).toContain("const inviteButton = document.getElementById('invite');");
  expect(out.trimEnd()).toEndWith(MARK);
});

test("fails loudly when a piece is missing", () => {
  for (const { from } of SWAPS) {
    const broken = shell.split(from).join("");
    expect(() => patchShell(broken)).toThrow(`shell.html: não achei o trecho ${JSON.stringify(from)}`);
  }
});

test("a shell patched already is refused", () => {
  expect(() => patchShell(out)).toThrow("shell.html: já foi ajustado");
});

test("the page's script still parses after every swap", () => {
  const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const code of scripts) expect(() => new Function(code)).not.toThrow();
});
