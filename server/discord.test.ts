import { expect, test } from "bun:test";
import { authorizeUrl, createDiscord, NotAllowed, scopesFor } from "./discord";

// Discord, faked: code "good" is Ana's.
const fake = (overrides: Record<string, Response> = {}) =>
  (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://discord.com/api/v10", "");
    if (overrides[path]) return overrides[path];
    if (path === "/oauth2/token") {
      const code = new URLSearchParams(String(init?.body)).get("code");
      return code === "good" ? Response.json({ access_token: "tok" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    if (path === "/users/@me") return Response.json({ id: "42", username: "ana", global_name: "Ana" });
    if (path === "/users/@me/guilds") return Response.json([{ id: "111111111111111111" }, { id: "222222222222222222" }]);
    return new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;

const discord = (fetch = fake()) => createDiscord({ clientId: "app", clientSecret: "s", fetch });

test("signIn: the user behind the code", async () => {
  expect(await discord().signIn("good")).toEqual({ id: "42", name: "Ana", accessToken: "tok" });
});

test("signIn: a bad code or Discord failing throws", async () => {
  await expect(discord().signIn("bad")).rejects.toThrow("token exchange");
  await expect(discord(fake({ "/users/@me": new Response(null, { status: 500 }) })).signIn("good")).rejects.toThrow("user lookup");
});

test("signIn in a browser: the address Discord came back to goes with the code, as Discord requires", async () => {
  let sent: URLSearchParams | null = null;
  const f = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/token")) {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "tok" });
    }
    return Response.json({ id: "42", username: "ana" });
  }) as unknown as typeof globalThis.fetch;
  await createDiscord({ clientId: "app", clientSecret: "s", fetch: f }).signIn("good", "https://hype.example/auth");
  expect(sent!.get("redirect_uri")).toBe("https://hype.example/auth");
});

test("signIn with ALLOWED_GUILDS: a member of one of them gets in, anyone else is NotAllowed", async () => {
  const only = (allowedGuilds: string[], fetch = fake()) => createDiscord({ clientId: "app", clientSecret: "s", allowedGuilds, fetch });
  expect(await only(["999999999999999999", "222222222222222222"]).signIn("good")).toEqual({ id: "42", name: "Ana", accessToken: "tok" });
  await expect(only(["999999999999999999"]).signIn("good")).rejects.toBeInstanceOf(NotAllowed);
  // Discord failing on the servers: no pass either way, and not taken for "not a member"
  for (const down of [new Response(null, { status: 503 }), new Response(null, { status: 401 })]) {
    const err = await only(["222222222222222222"], fake({ "/users/@me/guilds": down })).signIn("good").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotAllowed);
    expect((err as Error).message).toContain("guilds lookup");
  }
  const timeout = (async (url: string, init?: RequestInit) =>
    url.endsWith("/@me/guilds") ? Promise.reject(new DOMException("timed out", "TimeoutError")) : fake()(url, init)) as unknown as typeof globalThis.fetch;
  await expect(only(["222222222222222222"], timeout).signIn("good")).rejects.toThrow("timed out");
});

test("signIn without ALLOWED_GUILDS never asks for the servers", async () => {
  const asked: string[] = [];
  const f = (async (url: string, init?: RequestInit) => (asked.push(url), fake()(url, init))) as unknown as typeof globalThis.fetch;
  await discord(f).signIn("good");
  expect(asked.some((u) => u.endsWith("/guilds"))).toBe(false);
});

test("scopesFor: guilds only with ALLOWED_GUILDS", () => {
  expect(scopesFor([])).toEqual(["identify"]);
  expect(scopesFor(["222222222222222222"])).toEqual(["identify", "guilds"]);
  expect(new URL(authorizeUrl("app", "https://hype.example/auth", "s", scopesFor(["222222222222222222"]))).searchParams.get("scope")).toBe("identify guilds");
});

test("authorizeUrl: Discord's sign-in page, for the browser", () => {
  const u = new URL(authorizeUrl("app", "https://hype.example/auth", "st4te"));
  expect(u.origin + u.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "app", response_type: "code", scope: "identify", redirect_uri: "https://hype.example/auth", state: "st4te" });
});
