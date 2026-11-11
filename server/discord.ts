/**
 * Who's playing: whoever opens the Activity. The entry page asks Discord for a code (`authorize`, scope identify),
 * and this trades it server-side for the user, so a pass is only ever issued to someone Discord vouches for. In a
 * browser (outside Discord) the code comes from Discord's own sign-in page instead (authorizeUrl), and back to
 * `<PUBLIC_URL>/auth`, an address registered in the app's OAuth2 redirects. With ALLOWED_GUILDS, both ask for the
 * `guilds` scope too, and only a member of one of those servers gets in (NotAllowed otherwise).
 */

const API = "https://discord.com/api/v10";

/** What both sign-ins ask Discord for: the servers too when only some servers' members get in. */
export const scopesFor = (allowedGuilds: string[]): string[] => (allowedGuilds.length ? ["identify", "guilds"] : ["identify"]);

/** Discord's sign-in page for the browser: it comes back to `redirectUri` with a code and the same `state`. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string, scopes = ["identify"]): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", scope: scopes.join(" "), redirect_uri: redirectUri, state });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/** Signed in fine, but not a member of any of the allowed servers. */
export class NotAllowed extends Error {}

export interface DiscordOptions {
  clientId: string;
  clientSecret: string;
  /** ALLOWED_GUILDS: only their members get in. Empty: any Discord account. */
  allowedGuilds?: string[];
  fetch?: typeof globalThis.fetch;
}

export function createDiscord({ clientId, clientSecret, allowedGuilds = [], fetch = globalThis.fetch }: DiscordOptions) {
  return {
    /**
     * The user behind an `authorize` code, and their access token (the entry page authenticates the SDK with it).
     * `redirectUri`: the browser's sign-in (Discord wants the same address the code went to). Throws when the code is
     * bad or Discord fails (the servers' check too: no pass then), NotAllowed when not in an allowed server.
     */
    async signIn(code: string, redirectUri?: string): Promise<{ id: string; name: string; accessToken: string }> {
      const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code });
      if (redirectUri) form.set("redirect_uri", redirectUri);
      const res = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null;
      const token = body?.access_token;
      // Discord's reason (invalid_grant, invalid_request…) says which portal setting is off; it never holds a secret.
      if (!res.ok || !token) throw new Error(`discord token exchange failed (${res.status} ${body?.error ?? ""}: ${body?.error_description ?? ""})`);

      const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (!me.ok) throw new Error(`discord user lookup failed (${me.status})`);
      const u = (await me.json()) as { id: string; username: string; global_name?: string | null };
      if (allowedGuilds.length) {
        // (up to 200 servers, Discord's default and most anyone can be in)
        const mine = await fetch(`${API}/users/@me/guilds`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        if (!mine.ok) throw new Error(`discord guilds lookup failed (${mine.status})`);
        const guilds = (await mine.json()) as { id: string }[];
        if (!guilds.some((g) => allowedGuilds.includes(g.id))) throw new NotAllowed(`${u.id} is in none of the allowed servers`);
      }
      return { id: u.id, name: u.global_name || u.username, accessToken: token };
    },
  };
}

export type Discord = ReturnType<typeof createDiscord>;
