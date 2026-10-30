import { expect, test } from "bun:test";
import { createPasses } from "./pass";

let clock = 1_000_000;
const now = () => clock;
const HOUR = 60 * 60_000;
// HypeMeet's POST /api/plugins/pass, faked: these passes are good, anything else is a 401.
const issued: Record<string, object> = {
  ana: { plugin: "bt3", id: "Ana#1234", name: "Ana", exp: 1_000_000 + HOUR },
  draw: { plugin: "drawspace", id: "Ana#1234", name: "Ana", exp: 1_000_000 + HOUR },
};
let asked: string[] = [];
const fetch = (async (url: URL, init: RequestInit) => {
  expect(url.href).toBe("https://meet.example.com/api/plugins/pass");
  const { pass } = JSON.parse(init.body as string) as { pass: string };
  asked.push(pass);
  return issued[pass] ? Response.json(issued[pass]) : Response.json({ error: "Passe inválido" }, { status: 401 });
}) as unknown as typeof globalThis.fetch;
const passes = () => createPasses("https://meet.example.com/", "bt3", { now, fetch });

test("pass: HypeMeet vouches once, then it's remembered until it expires", async () => {
  clock = 1_000_000;
  asked = [];
  const p = passes();
  expect(await p.verify("ana")).toEqual({ id: "Ana#1234", name: "Ana", exp: 1_000_000 + HOUR });
  expect(await p.verify("ana")).not.toBeNull();
  expect(asked).toEqual(["ana"]);
  clock += HOUR;
  expect(await p.verify("ana")).toBeNull();
});

test("pass: refused by HypeMeet, another plugin's, or HypeMeet unreachable", async () => {
  clock = 1_000_000;
  expect(await passes().verify("forged")).toBeNull();
  expect(await passes().verify("draw")).toBeNull();
  const down = createPasses("https://meet.example.com/", "bt3", { now, fetch: (async () => { throw new Error("down"); }) as unknown as typeof globalThis.fetch });
  expect(await down.verify("ana")).toBeNull();
});
