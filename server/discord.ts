/**
 * Who's playing: whoever opens the Activity. The entry page asks Discord for a code (`authorize`, scope identify),
 * and this trades it server-side for the user, so a pass is only ever issued to someone Discord vouches for.
 */

const API = "https://discord.com/api/v10";

export interface DiscordOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
}

export function createDiscord({ clientId, clientSecret, fetch = globalThis.fetch }: DiscordOptions) {
  return {
    /** The user behind an `authorize` code. Throws when the code is bad or Discord fails. */
    async signIn(code: string): Promise<{ id: string; name: string }> {
      const res = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code }),
        signal: AbortSignal.timeout(5000),
      });
      const token = ((await res.json().catch(() => null)) as { access_token?: string } | null)?.access_token;
      if (!res.ok || !token) throw new Error(`discord token exchange failed (${res.status})`);

      const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (!me.ok) throw new Error(`discord user lookup failed (${me.status})`);
      const u = (await me.json()) as { id: string; username: string; global_name?: string | null };
      return { id: u.id, name: u.global_name || u.username };
    },
  };
}

export type Discord = ReturnType<typeof createDiscord>;
