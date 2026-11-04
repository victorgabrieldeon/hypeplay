import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cloudflareTurn, iceServers, STUN } from "./ice";

test("stun only without TURN settings", () => {
  expect(iceServers({ user: "42", now: 1_700_000_000_000 })).toEqual([{ urls: STUN }]);
  expect(iceServers({ turnUrl: "turn:x:3478", user: "42", now: 1_700_000_000_000 })).toEqual([{ urls: STUN }]);
});

test("turn with a 12 h coturn REST credential", () => {
  const username = `${1_700_000_000 + 43_200}:42`;
  const credential = createHmac("sha1", "s3cret").update(username).digest("base64");
  // (a plain turn: address goes out by UDP and by TCP: some networks only let TCP through)
  expect(iceServers({ turnUrl: "turn:turn.exemplo.com:3478", turnSecret: "s3cret", user: "42", now: 1_700_000_000_000 })).toEqual([
    { urls: STUN },
    { urls: ["turn:turn.exemplo.com:3478?transport=udp", "turn:turn.exemplo.com:3478?transport=tcp"], username, credential },
  ]);
});

test("a TURN address that says its transport, or turns:, goes out as it is", () => {
  for (const url of ["turn:turn.exemplo.com:3478?transport=tcp", "turns:turn.exemplo.com:5349"])
    expect(iceServers({ turnUrl: url, turnSecret: "s3cret", user: "42", now: 0 })[1]!.urls).toBe(url);
});

const CF_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/k1/credentials/generate-ice-servers";

/** Cloudflare's answer, as its docs show it (iceServers an object; an array is taken too). */
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Cloudflare's TURN: a 12 h credential asked for with the key's token, shared by everyone until it's about to expire", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let t = 1_700_000_000_000;
  const fetched = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return answer({ iceServers: { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "u1", credential: "c1" } });
  };
  const cf = cloudflareTurn({ keyId: "k1", token: "tok", fetch: fetched as unknown as typeof fetch, now: () => t });
  const first = await cf.ice();
  expect(first).toEqual({ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "u1", credential: "c1" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(CF_URL);
  expect(calls[0]!.init.method).toBe("POST");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: 43_200 });
  // (the same for the next player, and the next hour)
  t += 3_600_000;
  expect(await cf.ice()).toEqual(first);
  expect(calls).toHaveLength(1);
  // (an hour before it expires, a new one)
  t += 10 * 3_600_000 + 1;
  await cf.ice();
  expect(calls).toHaveLength(2);
});

test("Cloudflare's TURN: the answer as it really comes, STUN first and the TURN with the credential after; two players at once share one request", async () => {
  let n = 0;
  const fetched = async () => {
    n++;
    await new Promise((ok) => setTimeout(ok, 10));
    return answer({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:443"] }, { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }] });
  };
  const cf = cloudflareTurn({ keyId: "k1", token: "tok", fetch: fetched as unknown as typeof fetch, now: () => 0 });
  const [a, b] = await Promise.all([cf.ice(), cf.ice()]);
  expect(a).toEqual({ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" });
  expect(b).toEqual(a);
  expect(n).toBe(1);
});

test("Cloudflare's TURN failing (its API down, a bad token) is no TURN, tried again half a minute later", async () => {
  let t = 0;
  let n = 0;
  const fetched = async () => (n++, n < 3 ? answer({ error: "no" }, 401) : answer({ iceServers: { urls: ["turn:x"], username: "u", credential: "c" } }));
  const cf = cloudflareTurn({ keyId: "k1", token: "tok", fetch: fetched as unknown as typeof fetch, now: () => t });
  expect(await cf.ice()).toBeNull();
  expect(await cf.ice()).toBeNull();
  expect(n).toBe(1);
  t += 30_001;
  expect(await cf.ice()).toBeNull();
  expect(n).toBe(2);
  t += 30_001;
  expect(await cf.ice()).toEqual({ urls: ["turn:x"], username: "u", credential: "c" });
  // (and one that throws, the same as failing)
  const thrown = cloudflareTurn({ keyId: "k1", token: "tok", fetch: (async () => { throw new Error("net"); }) as unknown as typeof fetch, now: () => 0 });
  expect(await thrown.ice()).toBeNull();
});
