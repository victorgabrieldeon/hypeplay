import { expect, test } from "bun:test";
import { createDiscord } from "./discord";

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
  expect(await discord().signIn("good")).toEqual({ id: "42", name: "Ana" });
});

test("signIn: a bad code or Discord failing throws", async () => {
  await expect(discord().signIn("bad")).rejects.toThrow("token exchange");
  await expect(discord(fake({ "/users/@me": new Response(null, { status: 500 }) })).signIn("good")).rejects.toThrow("user lookup");
});
