/**
 * The access pass: proof that whoever loads the page signed in through the Discord Activity (discord.ts). The entry
 * page trades its Discord code for one, and the game lives under /p/<pass>/ from then on, because the iframe sends
 * no headers and, in Discord, has no cookie. It's signed here and read here: `<body>.<mac>`, body base64url JSON.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface Pass {
  /** The Discord user id. */
  id: string;
  /** Their display name, for "Fulano está enviando a ISO". */
  name: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export const PASS_TTL_MS = 12 * 60 * 60_000;

export function createPasses(secret: string, { now = () => Date.now() } = {}) {
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");

  return {
    issue({ id, name }: { id: string; name: string }): string {
      const body = Buffer.from(JSON.stringify({ id, name, exp: now() + PASS_TTL_MS })).toString("base64url");
      return `${body}.${sign(body)}`;
    },

    /** The pass's holder, or null when it's forged, malformed or expired. */
    async verify(pass: string): Promise<Pass | null> {
      const [body, mac, extra] = pass.split(".");
      if (!body || !mac || extra !== undefined) return null;
      const want = Buffer.from(sign(body));
      const got = Buffer.from(mac);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      let p: { id?: unknown; name?: unknown; exp?: unknown };
      try {
        p = JSON.parse(Buffer.from(body, "base64url").toString());
      } catch {
        return null;
      }
      if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.exp !== "number" || p.exp <= now()) return null;
      return { id: p.id, name: p.name, exp: p.exp };
    },
  };
}

export type Passes = ReturnType<typeof createPasses>;
