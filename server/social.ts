/**
 * Friends, in the spirit of Steam's: requests both ways, who's playing what, a profile with each person's hours per game,
 * their recent sessions and badges, games in common, and invites to play (with the room when the one inviting hosts one).
 *
 * Everyone who ever opened the home has a profile here (their name, kept for when they're offline). Hours come from a
 * game's page beat (presence.ts HERE_MS, every 15 s): the time since the last beat counts while it's the same game and
 * the beat came on time. Kept in one file (<dir>/social.json), in memory while the server runs and written a moment
 * after a change: one process, so no two writes race. Invites live in memory only (they're for right now).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HERE_MS, QUIET_MS } from "./presence";
import { USER } from "./saves";

export type Status = "online" | "away" | "busy" | "invisible";
const STATUSES = new Set<Status>(["online", "away", "busy", "invisible"]);

export interface Played {
  title: string;
  ms: number;
  sessions: number;
  last: number;
}
export interface Session {
  key: string;
  title: string;
  start: number;
  end: number;
}
interface Profile {
  name: string;
  since: number;
  seen: number;
  status: Status;
  note: string;
  games: Record<string, Played>;
  /** newest first */
  recent: Session[];
  friends: string[];
  /** requests they got / sent */
  incoming: string[];
  outgoing: string[];
  /** who they were in the same game with at the same time, and when last */
  with: Record<string, number>;
}
export interface Invite {
  id: string;
  from: string;
  name: string;
  /** a game's key and name; `code`: the room of the one inviting */
  key: string;
  title: string;
  code?: string;
  /** "invite": come play; "accepted": your invite was taken (their room shows in your list) */
  kind: "invite" | "accepted";
  at: number;
}

/** A beat later than this isn't the same sitting: the time between doesn't count. */
export const BEAT_GAP_MS = 2 * HERE_MS;
export const INVITE_TTL_MS = 5 * 60_000;
const NOTE_MAX = 80;
const MOST_FRIENDS = 300;
const MOST_RECENT = 20;
const MOST_INVITES = 10;
const MOST_WITH = 50;
/** The time at most between writes: hours played since are lost if the process dies meanwhile. */
const SAVE_MS = 2000;

const blank = (name: string, t: number): Profile => ({ name, since: t, seen: t, status: "online", note: "", games: {}, recent: [], friends: [], incoming: [], outgoing: [], with: {} });
const drop = (list: string[], id: string) => {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
};

/** Badges from what a profile says, computed (nothing to keep in sync). */
export function badges(p: { games: Record<string, Played>; recent: Session[]; friends: string[] }) {
  const hours = Object.values(p.games).reduce((s, g) => s + g.ms, 0) / 3_600_000;
  const top = Math.max(0, ...Object.values(p.games).map((g) => g.ms)) / 3_600_000;
  const out: { id: string; name: string; text: string }[] = [];
  if (hours >= 1) out.push({ id: "first", name: "Primeira hora", text: "Jogou a primeira hora no HypePlay" });
  if (hours >= 50) out.push({ id: "veteran", name: "Veterano", text: "Mais de 50 horas jogadas" });
  if (top >= 10) out.push({ id: "loyal", name: "Fiel", text: "10 horas ou mais num jogo só" });
  if (Object.keys(p.games).length >= 5) out.push({ id: "collector", name: "Colecionador", text: "Jogou 5 jogos diferentes" });
  if (p.recent.some((s) => s.end - s.start >= 3 * 3_600_000)) out.push({ id: "marathon", name: "Maratonista", text: "Uma sessão de 3 horas seguidas" });
  if (p.friends.length >= 5) out.push({ id: "crew", name: "Turma", text: "5 amigos ou mais" });
  return out;
}

export function createSocial(dir: string, now: () => number = () => Date.now()) {
  const file = join(dir, "social.json");
  let users: Record<string, Profile> = {};
  try {
    users = JSON.parse(readFileSync(file, "utf8")).users ?? {};
  } catch {
    // (no file yet: nobody's been here)
  }
  /** each one's last beat, for the time since it */
  const beats = new Map<string, { key: string; at: number }>();
  const invites = new Map<string, Invite[]>();
  /** when each one's "seen" was last written (the poll comes every 2 s: once a minute is enough) */
  const kept = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  function save() {
    if (timer) return;
    timer = setTimeout(flush, SAVE_MS);
  }
  /** Writes now (tests, and the timer). */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const body = JSON.stringify({ users });
    writing = writing.then(async () => {
      mkdirSync(dir, { recursive: true });
      await writeFile(`${file}.tmp`, body);
      await rename(`${file}.tmp`, file);
    });
    return writing;
  }

  const known = (id: string) => USER.test(id) && Object.hasOwn(users, id);
  const get = (id: string) => (known(id) ? users[id]! : null);
  const visible = (p: Profile) => p.status !== "invisible";

  function liveInvites(id: string) {
    const t = now();
    const list = (invites.get(id) ?? []).filter((i) => t - i.at < INVITE_TTL_MS);
    if (list.length) invites.set(id, list);
    else invites.delete(id);
    return list;
  }

  return {
    flush,

    /** The home opened (its poll): their profile, with the name the pass has now. */
    seen(pass: { id: string; name: string }) {
      if (!USER.test(pass.id)) return;
      const t = now();
      const fresh = !users[pass.id];
      const p = (users[pass.id] ??= blank(pass.name, t));
      if (fresh || p.name !== pass.name || t - (kept.get(pass.id) ?? 0) > 60_000) {
        kept.set(pass.id, t);
        save();
      }
      p.name = pass.name;
      p.seen = t;
    },

    /**
     * A game's page beat (or its closing: null). Counts the time since their last beat in the same game, and who else
     * (`alongside`, in the same game now) they're playing with. Watching someone doesn't count as playing.
     */
    beat(pass: { id: string; name: string }, game: { key: string; title: string; watch: boolean } | null, alongside: string[] = []) {
      if (!USER.test(pass.id)) return;
      const t = now();
      const p = (users[pass.id] ??= blank(pass.name, t));
      p.seen = t;
      const last = beats.get(pass.id);
      if (!game || game.watch) {
        beats.delete(pass.id);
        return save();
      }
      const g = (p.games[game.key] ??= { title: game.title, ms: 0, sessions: 0, last: t });
      g.title = game.title;
      g.last = t;
      const going = last && last.key === game.key && t - last.at <= BEAT_GAP_MS;
      if (going) {
        g.ms += t - last.at;
        if (p.recent[0]?.key === game.key) p.recent[0].end = t;
      } else {
        g.sessions++;
        p.recent.unshift({ key: game.key, title: game.title, start: t, end: t });
        p.recent.length = Math.min(p.recent.length, MOST_RECENT);
      }
      beats.set(pass.id, { key: game.key, at: t });
      for (const o of alongside) if (o !== pass.id && USER.test(o)) p.with[o] = t;
      const w = Object.entries(p.with);
      if (w.length > MOST_WITH) p.with = Object.fromEntries(w.sort((a, b) => b[1] - a[1]).slice(0, MOST_WITH));
      save();
    },

    /** Status and the note under the name ("procurando alguém pra jogar"). */
    setStatus(id: string, s: { status?: unknown; note?: unknown }): boolean {
      const p = get(id);
      if (!p || (s.status !== undefined && !STATUSES.has(s.status as Status)) || (s.note !== undefined && typeof s.note !== "string")) return false;
      if (s.status !== undefined) p.status = s.status as Status;
      if (typeof s.note === "string") p.note = s.note.trim().slice(0, NOTE_MAX);
      save();
      return true;
    },

    statusOf: (id: string): Status => get(id)?.status ?? "online",

    /** Add: a request, or, when they had asked already, friends. */
    add(me: string, them: string): "sent" | "friends" | "already" | "bad" {
      const a = get(me), b = get(them);
      if (!a || !b || me === them) return "bad";
      if (a.friends.includes(them)) return "already";
      if (a.friends.length >= MOST_FRIENDS || b.friends.length >= MOST_FRIENDS) return "bad";
      if (a.incoming.includes(them)) {
        drop(a.incoming, them);
        drop(b.outgoing, me);
        a.friends.push(them);
        b.friends.push(me);
        save();
        return "friends";
      }
      if (a.outgoing.includes(them)) return "already";
      if (b.incoming.length >= MOST_FRIENDS) return "bad";
      a.outgoing.push(them);
      b.incoming.push(me);
      save();
      return "sent";
    },

    /** Unfriend, decline or cancel: whatever there was between the two, gone on both sides. */
    remove(me: string, them: string): boolean {
      const a = get(me), b = get(them);
      if (!a || !b) return false;
      for (const [x, id] of [[a, them], [b, me]] as const) for (const list of [x.friends, x.incoming, x.outgoing]) drop(list, id);
      save();
      return true;
    },

    /** Come play `game` (with my room's code when I host one). Friends only; not to someone busy. */
    invite(me: string, to: string, game: { key: string; title: string; code?: string }): { ok: true } | { ok: false; error: string; status: number } {
      const a = get(me), b = get(to);
      if (!a || !b || !a.friends.includes(to)) return { ok: false, error: "Só dá para convidar amigos", status: 403 };
      if (b.status === "busy") return { ok: false, error: `${b.name} está em Não perturbe`, status: 409 };
      const list = liveInvites(to).filter((i) => !(i.from === me && i.kind === "invite"));
      if (list.length >= MOST_INVITES) return { ok: false, error: `${b.name} já tem convites demais`, status: 429 };
      list.push({ id: crypto.randomUUID(), from: me, name: a.name, kind: "invite", at: now(), ...game });
      invites.set(to, list);
      return { ok: true };
    },

    /** Taken (`accept`) or dismissed: off the list; taking one tells the one who invited. */
    answer(me: string, id: string, accept: boolean): Invite | null {
      const list = liveInvites(me);
      const inv = list.find((i) => i.id === id);
      if (!inv) return null;
      invites.set(me, list.filter((i) => i !== inv));
      const p = get(me);
      if (accept && inv.kind === "invite" && p) {
        const back = liveInvites(inv.from);
        if (back.length < MOST_INVITES) invites.set(inv.from, [...back, { id: crypto.randomUUID(), from: me, name: p.name, kind: "accepted", key: inv.key, title: inv.title, at: now() }]);
      }
      return inv;
    },

    /**
     * For the home's poll: my status, my friends (each with whether they're online: `online(id)`, presence.ts), the
     * requests both ways, my invites and what my friends played lately.
     */
    view(me: string, online: (id: string) => boolean) {
      const p = get(me);
      if (!p) return null;
      const who = (id: string) => ({ id, name: users[id]?.name ?? "?" });
      const friends = p.friends.filter((id) => users[id]).map((id) => {
        const f = users[id]!;
        const on = visible(f) && online(id);
        return { ...who(id), status: on ? f.status : "offline", note: f.note, seen: visible(f) ? f.seen : null, since: f.since };
      });
      const feed = p.friends
        .filter((id) => users[id] && visible(users[id]!))
        .flatMap((id) => users[id]!.recent.slice(0, 5).map((s) => ({ ...who(id), ...s })))
        .sort((x, y) => y.end - x.end)
        .slice(0, 12);
      return { id: me, status: p.status, note: p.note, friends, incoming: p.incoming.map(who), outgoing: p.outgoing.map(who), invites: liveInvites(me), feed };
    },

    /** Find someone to add, by name (offline too). */
    search(me: string, q: string) {
      const s = q.trim().toLocaleLowerCase("pt-BR");
      if (!s) return [];
      return Object.entries(users)
        .filter(([id, u]) => id !== me && u.name.toLocaleLowerCase("pt-BR").includes(s))
        .slice(0, 10)
        .map(([id, u]) => ({ id, name: u.name, relation: relation(me, id) }));
    },

    /** Someone's profile, seen by `me`: hours per game, recent sessions, badges, games and friends in common. */
    profile(me: string, id: string) {
      const p = get(id), mine = get(me);
      if (!p || !mine) return null;
      const hidden = id !== me && !visible(p);
      // (invisible: nothing that says they're on right now)
      const quiet = (at: number) => !hidden || now() - at > QUIET_MS;
      const games = Object.entries(p.games).map(([key, g]) => ({ key, ...g, last: quiet(g.last) ? g.last : 0 })).sort((a, b) => b.ms - a.ms);
      return {
        id,
        name: p.name,
        note: p.note,
        status: id === me ? p.status : hidden ? "offline" : p.status,
        since: p.since,
        seen: hidden ? null : p.seen,
        relation: relation(me, id),
        total: games.reduce((s, g) => s + g.ms, 0),
        games,
        recent: p.recent.filter((s) => quiet(s.end)).slice(0, 10),
        badges: badges(p),
        friends: p.friends.length,
        mutual: id === me ? [] : p.friends.filter((f) => f !== me && mine.friends.includes(f)).map((f) => ({ id: f, name: users[f]?.name ?? "?" })),
        common: id === me ? [] : games.filter((g) => mine.games[g.key]).map((g) => ({ key: g.key, title: g.title, mine: mine.games[g.key]!.ms, theirs: g.ms })),
        with: Object.entries(p.with).filter(([o, at]) => users[o] && (visible(users[o]!) || now() - at > QUIET_MS)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o, at]) => ({ id: o, name: users[o]!.name, at })),
      };
    },
  };

  function relation(me: string, id: string): "self" | "friend" | "incoming" | "outgoing" | "none" {
    const p = users[me];
    if (me === id) return "self";
    if (!p) return "none";
    return p.friends.includes(id) ? "friend" : p.incoming.includes(id) ? "incoming" : p.outgoing.includes(id) ? "outgoing" : "none";
  }
}

export type Social = ReturnType<typeof createSocial>;
