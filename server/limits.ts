/**
 * How often each person (their pass's Discord id) may do what costs the server the most or reaches other people:
 * adding a game, starting a disc image's upload, a download from vimm.net, a "versão rápida", an invite, a friend
 * request. Past the limit the request is answered 429 with a message the home shows as it is. In this process's
 * memory, a sliding window per person and action; only what went through counts (a refused or failed one gives its
 * turn back: ops.ts).
 */

export type Action = "reserve" | "iso" | "vimm" | "fast" | "invite" | "friend";

export const LIMITS: Record<Action, { max: number; windowMs: number; what: string }> = {
  reserve: { max: 20, windowMs: 3_600_000, what: "jogos adicionados" },
  // (each upload starting from its first byte: a dropped connection resumes where it stopped, not from 0)
  iso: { max: 20, windowMs: 3_600_000, what: "envios de ISO" },
  vimm: { max: 10, windowMs: 3_600_000, what: "downloads do vimm.net" },
  fast: { max: 10, windowMs: 3_600_000, what: "pedidos de versão rápida" },
  invite: { max: 30, windowMs: 600_000, what: "convites" },
  // (accepting one is the same POST: generous)
  friend: { max: 40, windowMs: 3_600_000, what: "pedidos de amizade" },
};

/** The action a request under /p/<pass> is (`path` after the pass), or null for one that isn't limited. */
export function actionOf(method: string, path: string, search: URLSearchParams): Action | null {
  if (method === "POST") {
    if (path === "/ps2") return "reserve";
    if (path === "/vimm") return "vimm";
    if (path === "/invite") return "invite";
    if (/^\/friends\/[^/]+$/.test(path)) return "friend";
    if (/^\/ps2\/[^/]+\/fast-build$/.test(path)) return "fast";
  }
  if (method === "PUT" && /^\/ps2\/[^/]+\/upload$/.test(path) && search.get("offset") === "0") return "iso";
  return null;
}

/** "Tente de novo em …": minutes, rounded up. */
export function limitMessage(action: Action, retryMs: number): string {
  const min = Math.max(1, Math.ceil(retryMs / 60_000));
  return `Muitos ${LIMITS[action].what} em pouco tempo. Tente de novo em ${min} ${min === 1 ? "minuto" : "minutos"}.`;
}

export class RateLimiter {
  /** "<who>/<action>" → when each turn was taken, oldest first */
  private turns = new Map<string, number[]>();
  private swept = 0;

  constructor(
    private now: () => number = () => Date.now(),
    private limits = LIMITS,
  ) {}

  /** A turn for `who`: `undo` gives it back; refused, how long until the oldest frees up. */
  take(who: string, action: Action): { ok: true; undo(): void } | { ok: false; retryMs: number } {
    const t = this.now();
    this.sweep(t);
    const { max, windowMs } = this.limits[action];
    const key = `${who}/${action}`;
    const list = (this.turns.get(key) ?? []).filter((at) => t - at < windowMs);
    if (list.length >= max) {
      this.turns.set(key, list);
      return { ok: false, retryMs: windowMs - (t - list[0]!) };
    }
    list.push(t);
    this.turns.set(key, list);
    return {
      ok: true,
      undo: () => {
        const l = this.turns.get(key);
        const i = l?.lastIndexOf(t) ?? -1;
        if (i >= 0) l!.splice(i, 1);
      },
    };
  }

  /** People tracked now (tests). */
  get size() {
    return this.turns.size;
  }

  /** Once a minute, the lists with nothing left in their window go. */
  private sweep(t: number) {
    if (t - this.swept < 60_000) return;
    this.swept = t;
    for (const [key, list] of this.turns) {
      const action = key.slice(key.lastIndexOf("/") + 1) as Action;
      if (!list.some((at) => t - at < this.limits[action].windowMs)) this.turns.delete(key);
    }
  }
}
