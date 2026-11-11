/**
 * The ICE servers the PS2 games' WebRTC uses: public STUN always (the page's own defaults) and, when the server has a
 * key, Cloudflare's TURN for players whose networks can't reach each other directly.
 */
import { log } from "./log";

export const STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Cloudflare's TURN (Realtime), a key made in its dashboard: TURN_CF_KEY_ID and TURN_CF_TOKEN. */
export interface CloudflareTurn {
  /** The TURN server for the players' browsers, with a credential good for a while; null, none to give right now. */
  ice(): Promise<IceServer | null>;
}

const CF_TTL_S = 12 * 60 * 60;
/** Asked for again this long before it expires, so a game starting then still has hours. */
const CF_RENEW_MS = 60 * 60 * 1000;
/** After a failure (its API down, a bad token), not asked again for this long: the games go on with STUN. */
const CF_RETRY_MS = 30 * 1000;

/**
 * One short-lived credential for everyone, from Cloudflare's "generate-ice-servers", kept until an hour before it
 * expires. It's anycast: each player's browser reaches the Cloudflare location nearest to it. Players asking at the
 * same time share one request; a failure gives no TURN (STUN only) for half a minute, then it's tried again.
 */
export function cloudflareTurn({ keyId, token, fetch: fetched = fetch, now = Date.now }: { keyId: string; token: string; fetch?: typeof fetch; now?: () => number }): CloudflareTurn {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  let kept: { server: IceServer; until: number } | null = null;
  let failedAt = -Infinity;
  let asking: Promise<IceServer | null> | null = null;

  async function ask(): Promise<IceServer | null> {
    const at = now();
    try {
      const r = await fetched(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: CF_TTL_S }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { iceServers?: IceServer | IceServer[] };
      // The answer lists its STUN first and the TURN, the one with the credential, after it.
      const s = [body.iceServers ?? []].flat().find((x) => x && x.urls && typeof x.username === "string" && typeof x.credential === "string");
      if (!s) throw new Error("no TURN with a credential in the answer");
      const server: IceServer = { urls: s.urls, username: s.username, credential: s.credential };
      kept = { server, until: at + CF_TTL_S * 1000 - CF_RENEW_MS };
      return server;
    } catch (err) {
      failedAt = at;
      log.warn("Cloudflare TURN: no credential", { err });
      return null;
    }
  }

  return {
    ice() {
      const t = now();
      if (kept && t < kept.until) return Promise.resolve(kept.server);
      if (!asking) {
        if (t - failedAt < CF_RETRY_MS) return Promise.resolve(null);
        asking = ask().finally(() => (asking = null));
      }
      return asking;
    },
  };
}
