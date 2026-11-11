/**
 * Who's around, for the home's "Pessoas": everyone who has the library open or had it or a game open lately, in this
 * process's memory (nothing is kept). The library's socket (homefeed.ts) says they're here for as long as it's open;
 * without it, the library's poll (routes.ts' games, every 2 s) does. A game's page says which game (overlay.ts, every
 * HERE_MS, and once more, empty, when it closes). Clock injectable for tests.
 */
import type { Pass } from "./pass";

/** How often a game's page says it's still open. */
export const HERE_MS = 15_000;
/**
 * Not heard from for this long: gone (a game's page missed two beats, or the library closed). A library closing its
 * socket counts from then: reloading it or opening a game from it (the game's page beats at once) isn't leaving.
 */
export const QUIET_MS = 40_000;

/** What a game's page is, from its path under /p/<pass>/: the game's key, and whether it only watches someone. */
export function gameFrom(path: string): { key: string; watch: boolean } | null {
  const ps2 = /^ps2\/([a-z]{4}-\d{5}(?:-\d{1,2})?)\/(game|fast|watch)\//.exec(path);
  if (ps2) return { key: `ps2/${ps2[1]}`, watch: ps2[2] === "watch" && /[?&]watch=1(&|$)/.test(path) };
  const port = /^([a-z0-9]{1,16})\/game\//.exec(path);
  return port ? { key: port[1]!, watch: false } : null;
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
  /** the libraries open (their sockets) per person: here while there's one, whenever they last said anything */
  private open = new Map<string, number>();

  constructor(private now: () => number = () => Date.now()) {}

  /** The library's poll: here (still in the game, if its page spoke lately). */
  library(pass: Pass) {
    const p = this.people.get(pass.id);
    this.people.set(pass.id, { id: pass.id, name: pass.name, call: pass.call, game: p?.game ?? null, at: this.now() });
  }

  /** The library's socket opened: here until it closes. */
  connect(pass: Pass) {
    this.open.set(pass.id, (this.open.get(pass.id) ?? 0) + 1);
    this.library(pass);
  }

  /** It closed: here a while longer, as after the poll's last look (QUIET_MS). */
  disconnect(pass: Pass) {
    const n = (this.open.get(pass.id) ?? 0) - 1;
    if (n > 0) this.open.set(pass.id, n);
    else this.open.delete(pass.id);
    this.library(pass);
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
      if (t - p.at > QUIET_MS && !this.open.has(id)) this.people.delete(id);
      else if (id !== me) out.push({ ...p, game: p.game && t - p.game.at <= QUIET_MS ? p.game : null });
    }
    return out;
  }
}
