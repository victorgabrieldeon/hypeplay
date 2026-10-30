/**
 * Who may play: whoever opens the Activity and is a member of one of the allowed guilds (DISCORD_GUILDS). The entry
 * page asks Discord for a code (`authorize`, scopes identify + guilds.members.read), and this checks it server-side:
 * the guild the client says it's in is never trusted.
 */

const API = "https://discord.com/api/v10";

export interface DiscordOptions {
  clientId: string;
  clientSecret: string;
  /** Guild ids whose members may play. */
  guilds: string[];
  fetch?: typeof globalThis.fetch;
}

export function createDiscord({ clientId, clientSecret, guilds, fetch = globalThis.fetch }: DiscordOptions) {
  const get = (path: string, token: string) =>
    fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });

  return {
    /** The user behind an `authorize` code; null when they're in none of the allowed guilds. Throws when Discord fails. */
    async signIn(code: string): Promise<{ id: string; name: string } | null> {
      const res = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code }),
        signal: AbortSignal.timeout(5000),
      });
      const token = ((await res.json().catch(() => null)) as { access_token?: string } | null)?.access_token;
      if (!res.ok || !token) throw new Error(`discord token exchange failed (${res.status})`);

      const me = await get("/users/@me", token);
      if (!me.ok) throw new Error(`discord user lookup failed (${me.status})`);
      const u = (await me.json()) as { id: string; username: string; global_name?: string | null };

      for (const guild of guilds) {
        const member = await get(`/users/@me/guilds/${guild}/member`, token);
        if (member.ok) return { id: u.id, name: u.global_name || u.username };
        // not a member: 404 (Unknown Guild), or 403 for a guild the token can't see
        if (member.status !== 404 && member.status !== 403) throw new Error(`discord member lookup failed (${member.status})`);
      }
      return null;
    },
  };
}

export type Discord = ReturnType<typeof createDiscord>;
