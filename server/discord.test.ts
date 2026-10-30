import { expect, test } from "bun:test";
import { createDiscord } from "./discord";

// Discord, faked: code "good" is Ana's; she's a member of guild "200" only.
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
    if (path === "/users/@me/guilds/200/member") return Response.json({ nick: null });
    return Response.json({ message: "Unknown Guild" }, { status: 404 });
  }) as unknown as typeof globalThis.fetch;

const discord = (guilds: string[], fetch = fake()) => createDiscord({ clientId: "app", clientSecret: "s", guilds, fetch });

test("signIn: a member of an allowed guild", async () => {
  expect(await discord(["100", "200"]).signIn("good")).toEqual({ id: "42", name: "Ana" });
});

test("signIn: in none of the allowed guilds", async () => {
  expect(await discord(["100", "300"]).signIn("good")).toBeNull();
});

test("signIn: a bad code or Discord failing throws", async () => {
  await expect(discord(["200"]).signIn("bad")).rejects.toThrow("token exchange");
  const down = fake({ "/users/@me/guilds/200/member": new Response(null, { status: 429 }) });
  await expect(discord(["200"], down).signIn("good")).rejects.toThrow("member lookup");
});
