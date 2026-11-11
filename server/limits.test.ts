import { expect, test } from "bun:test";
import { actionOf, limitMessage, LIMITS, RateLimiter } from "./limits";

const q = (s = "") => new URLSearchParams(s);

test("only the requests that create something are limited", () => {
  expect(actionOf("POST", "/ps2", q())).toBe("reserve");
  expect(actionOf("POST", "/vimm", q())).toBe("vimm");
  expect(actionOf("GET", "/vimm", q())).toBeNull();
  expect(actionOf("POST", "/invite", q())).toBe("invite");
  // (answering an invite isn't sending one)
  expect(actionOf("POST", "/invite/abc", q())).toBeNull();
  expect(actionOf("POST", "/friends/123", q())).toBe("friend");
  expect(actionOf("DELETE", "/friends/123", q())).toBeNull();
  expect(actionOf("POST", "/ps2/slus-21678/fast-build", q())).toBe("fast");
  expect(actionOf("DELETE", "/ps2/slus-21678/fast-build", q())).toBeNull();
  // an upload counts once, at its first byte: never its pieces
  expect(actionOf("PUT", "/ps2/slus-21678/upload", q("offset=0&size=10"))).toBe("iso");
  expect(actionOf("PUT", "/ps2/slus-21678/upload", q("offset=41943040&size=99"))).toBeNull();
  expect(actionOf("GET", "/ps2/slus-21678/upload", q())).toBeNull();
});

test("past the limit, refused until the oldest turn leaves the window", () => {
  let t = 0;
  const l = new RateLimiter(() => t, { ...LIMITS, invite: { max: 2, windowMs: 1000, what: "convites" } });
  expect(l.take("a", "invite").ok).toBe(true);
  t = 100;
  expect(l.take("a", "invite").ok).toBe(true);
  t = 200;
  const no = l.take("a", "invite");
  expect(no).toEqual({ ok: false, retryMs: 800 });
  // (per person and per action)
  expect(l.take("b", "invite").ok).toBe(true);
  expect(l.take("a", "friend").ok).toBe(true);
  t = 1000;
  expect(l.take("a", "invite").ok).toBe(true);
});

test("a turn given back doesn't count", () => {
  const l = new RateLimiter(() => 0, { ...LIMITS, vimm: { max: 1, windowMs: 1000, what: "x" } });
  const r = l.take("a", "vimm");
  if (!r.ok) throw new Error("refused");
  r.undo();
  expect(l.take("a", "vimm").ok).toBe(true);
  expect(l.take("a", "vimm").ok).toBe(false);
});

test("people with nothing left in their window are forgotten", () => {
  let t = 0;
  const l = new RateLimiter(() => t);
  l.take("a", "invite");
  t = LIMITS.invite.windowMs + 61_000;
  l.take("b", "invite");
  expect(l.size).toBe(1);
});

test("the message says what and for how long, in minutes", () => {
  expect(limitMessage("iso", 30_000)).toBe("Muitos envios de ISO em pouco tempo. Tente de novo em 1 minuto.");
  expect(limitMessage("friend", 125_000)).toBe("Muitos pedidos de amizade em pouco tempo. Tente de novo em 3 minutos.");
});
