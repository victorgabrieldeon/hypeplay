import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK, patchShell, SWAPS } from "./patch";

// web/shell.html of ps2-web-recomp at the commit the builder pins (MIT; see fixtures/README.md).
const shell = readFileSync(join(import.meta.dir, "fixtures", "shell.html"), "utf8").replace(/\r\n/g, "\n");
const out = patchShell(shell);

test("saves go to the server instead of the browser", () => {
  expect(out).not.toContain("IDBFS");
  expect(out).not.toContain("FS.syncfs");
  expect(out).toContain("fetch('../save', { cache: 'no-store' })");
  expect(out).toContain("fetch('../save', { method: 'PUT', body: data })");
  // Export / Import card are untouched
  expect(out).toContain("link.download = 'Mcd001.ps2';");
});

test("isolation missing in a frame offers the browser", () => {
  expect(out).toContain("t: 'cordplay:open', path: location.pathname");
  expect(out).toContain("Abrir no navegador");
  expect(out).toContain("Este navegador ainda não roda o jogo. Falta: ");
  expect(out).not.toContain("This browser cannot run the game yet");
});

test("rooms: ice from the server, Portuguese labels, no link copy", () => {
  expect(out).toContain("let rtcConfig = ");
  expect(out).toContain("fetch('ice')");
  expect(out).not.toContain("clipboard.writeText(link)");
  expect(out).toContain(">Abrir sala</button>");
  expect(out).toContain("'Sala ' + room");
  expect(out).toContain("'Entrar na sala ' + guestRoom");
  expect(out).toContain("'Jogando como jogador 2 na sala ' + guestRoom");
  expect(out).toContain("Não deu para conectar com o host. Talvez a rede de um dos dois bloqueie; o servidor precisa de um TURN.");
  expect(out).toContain("location.href = '../../../'");
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
