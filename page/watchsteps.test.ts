import { expect, test } from "bun:test";
import { stuckAt, turnState, whereAmI } from "./watchsteps";

test("player 2 is told where joining stopped, and what that usually means", () => {
  const start = stuckAt("start", "RTCPeerConnection is not defined");
  expect(start.title).toBe("Não deu para preparar a conexão");
  expect(start.text).toContain("RTCPeerConnection is not defined");
  expect(start.browser).toBe(true);
  expect(stuckAt("joining").title).toBe("O servidor não respondeu");
  expect(stuckAt("waiting").title).toBe("O host não respondeu");
  expect(stuckAt("linking").text).toContain("TURN");
  // (a step's own words stay when no error came with it)
  expect(stuckAt("waiting").text).not.toContain("()");
});

test("no WebRTC outside Discord: on Discord's own address, or a browser that won't, there's no browser to go to", () => {
  const site = stuckAt("start", "RTCPeerConnection is not a constructor", "discord-site");
  expect(site.title).toBe("O endereço do Discord bloqueia o vídeo");
  expect(site.text).toContain("discordsays.com");
  expect(site.text).toContain("PUBLIC_URL");
  expect(site.browser).toBe(false);
  const browser = stuckAt("start", "RTCPeerConnection is not defined", "browser");
  expect(browser.text).toContain("Chrome ou Edge");
  expect(browser.text).not.toContain("Abra no navegador");
  expect(browser.browser).toBe(false);
  // (inside Discord, as before: the browser is the way out)
  expect(stuckAt("start", "x", "discord").browser).toBe(true);
});

test("networks that don't meet: the TURN, and the browser only offered to who isn't in one", () => {
  const inBrowser = stuckAt("linking", undefined, "browser");
  expect(inBrowser.text).toContain("TURN");
  expect(inBrowser.text).not.toContain("No navegador");
  expect(inBrowser.browser).toBe(false);
  expect(stuckAt("linking", undefined, "discord").browser).toBe(true);
});

test("with a TURN on the server: whether it answered this browser says what to look at", () => {
  const silent = stuckAt("linking", undefined, "browser", "silent");
  expect(silent.title).toBe("O TURN do servidor não respondeu");
  expect(silent.text).toContain("3478");
  expect(silent.text).toContain("49160");
  const answered = stuckAt("linking", undefined, "browser", "answered");
  expect(answered.title).toBe("Sem conexão com o host");
  expect(answered.text).toContain("Nem pelo TURN");
  // (without one, as before)
  expect(stuckAt("linking", undefined, "browser", "none").text).toContain("precisa ligar um TURN");
});

test("whether this browser got a way through the TURN: the server offered one, and a relay candidate came", () => {
  const turn = [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["turn:t.example:3478?transport=udp"], username: "u", credential: "c" }];
  expect(turnState([{ urls: "stun:x" }], "a=candidate:1 1 udp 1 1.2.3.4 5 typ srflx")).toBe("none");
  expect(turnState(turn, "a=candidate:1 1 udp 1 1.2.3.4 5 typ srflx")).toBe("silent");
  expect(turnState(turn, "a=candidate:1 1 udp 1 1.2.3.4 5 typ relay raddr 0.0.0.0")).toBe("answered");
});

test("which window player 2 is in: Discord's, Discord's address in a browser tab, or the server's own", () => {
  expect(whereAmI(true, "1565741822813409280.discordsays.com")).toBe("discord");
  expect(whereAmI(false, "1565741822813409280.discordsays.com")).toBe("discord-site");
  expect(whereAmI(false, "hypeplay.example.com")).toBe("browser");
});
