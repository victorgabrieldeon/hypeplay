import { expect, test } from "bun:test";
import { authorizeUrl, createDiscord } from "./discord";

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

test("authorizeUrl: Discord's sign-in page, for the browser", () => {
  const u = new URL(authorizeUrl("app", "https://hype.example/auth", "st4te"));
  expect(u.origin + u.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "app", response_type: "code", scope: "identify", redirect_uri: "https://hype.example/auth", state: "st4te" });
});
