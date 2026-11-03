import { expect, test } from "bun:test";
import { createPasses, PASS_TTL_MS } from "./pass";

let clock = 1_000_000;
const now = () => clock;
const ana = { id: "123456789012345678", name: "Ana Clara" };

test("pass: issued here, read back until it expires", async () => {
  clock = 1_000_000;
  const p = createPasses("secret", { now });
  const pass = p.issue(ana);
  expect(pass).toMatch(/^[\w-]+\.[\w-]+$/); // fits /p/<pass>/
  expect(await p.verify(pass)).toEqual({ ...ana, exp: 1_000_000 + PASS_TTL_MS });
  clock += PASS_TTL_MS;
  expect(await p.verify(pass)).toBeNull();
});

test("pass: forged, tampered, another secret's, or malformed", async () => {
  clock = 1_000_000;
  const p = createPasses("secret", { now });
  const [body, mac] = p.issue(ana).split(".") as [string, string];
  const evil = Buffer.from(JSON.stringify({ id: "1", name: "Eve", exp: Infinity })).toString("base64url");
  for (const bad of [`${evil}.${mac}`, `${body}.${mac.slice(1)}`, `${body}.${mac}.x`, body, "", createPasses("other", { now }).issue(ana)])
    expect(await p.verify(bad)).toBeNull();
});

test("pass: carries the voice channel it was opened in, when it looks like one", async () => {
  clock = 1_000_000;
  const p = createPasses("secret", { now });
  expect((await p.verify(p.issue({ ...ana, call: "998877665544332211" })))?.call).toBe("998877665544332211");
  expect(await p.verify(p.issue({ ...ana, call: "not a channel" }))).toEqual({ ...ana, exp: 1_000_000 + PASS_TTL_MS });
});
