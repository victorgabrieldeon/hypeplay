import { expect, test } from "bun:test";
import { stuckAt } from "./watchsteps";

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
