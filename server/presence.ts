/**
 * Who's around, for the home's "Pessoas": everyone who had the library or a game open lately, in this process's memory
 * (nothing is kept). The library's poll (routes.ts' games, every 2 s) says they're here; a game's page says which
 * game (overlay.ts, every HERE_MS, and once more, empty, when it closes). Clock injectable for tests.
 */
import type { Pass } from "./pass";

/** How often a game's page says it's still open. */
export const HERE_MS = 15_000;
/** Not heard from for this long: gone (a game's page missed two beats, or the library closed). */
export const QUIET_MS = 40_000;

/** What a game's page is, from its path under /p/<pass>/: the game's key, and whether it only watches someone. */
export function gameFrom(path: string): { key: string; watch: boolean; slug?: string } | null {
  const ps2 = /^ps2\/([a-z]{4}-\d{5}(?:-\d{1,2})?)\/(game|fast|watch)\//.exec(path);
  if (ps2) return { key: `ps2/${ps2[1]}`, watch: ps2[2] === "watch" && /[?&]watch=1(&|$)/.test(path) };
  const port = /^([a-z0-9]{1,16})\/game\//.exec(path);
  if (port) return { key: port[1]!, watch: false };
  const slug = /^play\/\?(?:.*&)?g=([\w.-]{1,100})(&|$)/.exec(path)?.[1];
  return slug ? { key: `homebrew/${slug}`, watch: false, slug } : null;
}

export interface Person {
  id: string;
  name: string;
  call?: string;
  /** The game open, with its name, and since when its page said so; null, the library. */
  game: { key: string; title: string; watch: boolean; at: number } | null;
  at: number;
}

export class Presence {
  private people = new Map<string, Person>();

  constructor(private now: () => number = () => Date.now()) {}

  /** The library's poll: here (still in the game, if its page spoke lately). */
  library(pass: Pass) {
    const p = this.people.get(pass.id);
    this.people.set(pass.id, { id: pass.id, name: pass.name, call: pass.call, game: p?.game ?? null, at: this.now() });
  }

  /** A game's page: in that game; null, it closed. */
  playing(pass: Pass, game: { key: string; title: string; watch: boolean } | null) {
    const t = this.now();
    this.people.set(pass.id, { id: pass.id, name: pass.name, call: pass.call, game: game && { ...game, at: t }, at: t });
  }

  /** Everyone heard from lately but `me`, with a game only while its page still beats. */
  others(me: string): Person[] {
    const t = this.now();
    const out: Person[] = [];
    for (const [id, p] of this.people) {
      if (t - p.at > QUIET_MS) this.people.delete(id);
      else if (id !== me) out.push({ ...p, game: p.game && t - p.game.at <= QUIET_MS ? p.game : null });
    }
    return out;
  }
}
