/**
 * The access pass: proof that whoever loads the page is in some HypeMeet room. The manifest asks for one
 * ("pass": true), the room opens the page with ?pass=<pass>, and the page lives under /p/<pass>/ from then on,
 * because the iframe sends no headers and, in Discord, has no cookie. Only HypeMeet can read a pass: it's asked
 * once (POST /api/plugins/pass) and remembered until it expires.
 */

export interface Pass {
  /** The room identity it was issued to (one connection). */
  id: string;
  /** Their nickname, for "Fulano está enviando a ISO". */
  name: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export function createPasses(hypemeetUrl: string, plugin: string, { now = () => Date.now(), fetch = globalThis.fetch } = {}) {
  const known = new Map<string, Pass>();

  return {
    /** The pass's holder, or null when HypeMeet doesn't vouch for it (or can't be reached), or it's another plugin's. */
    async verify(pass: string): Promise<Pass | null> {
      const hit = known.get(pass);
      if (hit) return hit.exp > now() ? hit : null;
      const res = await fetch(new URL("/api/plugins/pass", hypemeetUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pass }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!res?.ok) return null;
      const p = (await res.json().catch(() => null)) as { plugin?: unknown; id?: unknown; name?: unknown; exp?: unknown } | null;
      if (p?.plugin !== plugin || typeof p.id !== "string" || typeof p.name !== "string" || typeof p.exp !== "number" || p.exp <= now())
        return null;
      for (const [k, v] of known) if (v.exp <= now()) known.delete(k);
      const valid = { id: p.id, name: p.name, exp: p.exp };
      known.set(pass, valid);
      return valid;
    },
  };
}

export type Passes = ReturnType<typeof createPasses>;
