/**
 * Friends, in the spirit of Steam's: requests both ways, who's playing what, a profile with each person's hours per game,
 * their recent sessions and badges, games in common, and invites to play (with the room when the one inviting hosts one).
 *
 * Everyone who ever opened the home has a profile here (their name, kept for when they're offline). Hours come from a
 * game's page beat (presence.ts HERE_MS, every 15 s): the time since the last beat counts while it's the same game and
 * the beat came on time. Kept in the database (db.ts: profiles, links, played, recent, played_with), in memory while
 * the server runs, and the profiles that changed written a moment after, together: one process, so no two writes
 * race. The old <dir>/social.json is imported once and left there. Invites live in memory only (they're for right now).
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importOnce, openDb } from "./db";
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

/** Writes these profiles whole (each one's rows in every table: delete, insert). */
function store(db: Database, users: Record<string, Profile>, ids: Iterable<string>, { keep = false } = {}) {
  // (`keep`: the import, where a row already there wins)
  const or = keep ? "OR IGNORE" : "OR REPLACE";
  // (an upsert, not a replace: the row keeps its place, the order of search's results)
  const profile = db.query(
    `INSERT INTO profiles (id, name, since, seen, status, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO ${keep ? "NOTHING" : "UPDATE SET name = excluded.name, seen = excluded.seen, status = excluded.status, note = excluded.note"}`,
  );
  const link = db.query(`INSERT ${or} INTO links (user, other, kind, pos) VALUES (?, ?, ?, ?)`);
  const played = db.query(`INSERT ${or} INTO played (user, key, title, ms, sessions, last) VALUES (?, ?, ?, ?, ?, ?)`);
  const recent = db.query(`INSERT ${or} INTO recent (user, pos, key, title, start, "end") VALUES (?, ?, ?, ?, ?, ?)`);
  const along = db.query(`INSERT ${or} INTO played_with (user, other, at) VALUES (?, ?, ?)`);
  const clear = ["links", "played", "recent", "played_with"].map((t) => db.query(`DELETE FROM ${t} WHERE user = ?`));
  for (const id of ids) {
    const p = users[id];
    if (!p) continue;
    if (!keep) for (const q of clear) q.run(id);
    profile.run(id, p.name, p.since, p.seen, p.status, p.note);
    for (const kind of ["friends", "incoming", "outgoing"] as const) p[kind].forEach((o, i) => link.run(id, o, kind, i));
    for (const [key, g] of Object.entries(p.games)) played.run(id, key, g.title, g.ms, g.sessions, g.last);
    p.recent.forEach((r, i) => recent.run(id, i, r.key, r.title, r.start, r.end));
    for (const [o, at] of Object.entries(p.with)) along.run(id, o, at);
  }
}

/** Everyone, from the database. */
function load(db: Database): Record<string, Profile> {
  const users: Record<string, Profile> = {};
  type Row = Record<string, string | number>;
  for (const r of db.query("SELECT * FROM profiles ORDER BY rowid").all() as Row[]) {
    users[r.id as string] = { ...blank(r.name as string, r.since as number), seen: r.seen as number, status: r.status as Status, note: r.note as string };
  }
  for (const r of db.query("SELECT * FROM links ORDER BY user, kind, pos").all() as Row[]) users[r.user as string]?.[r.kind as "friends"].push(r.other as string);
  for (const r of db.query("SELECT * FROM played ORDER BY rowid").all() as Row[]) {
    const p = users[r.user as string];
    if (p) p.games[r.key as string] = { title: r.title as string, ms: r.ms as number, sessions: r.sessions as number, last: r.last as number };
  }
  for (const r of db.query("SELECT * FROM recent ORDER BY user, pos").all() as Row[]) {
    users[r.user as string]?.recent.push({ key: r.key as string, title: r.title as string, start: r.start as number, end: r.end as number });
  }
  for (const r of db.query("SELECT * FROM played_with").all() as Row[]) {
    const p = users[r.user as string];
    if (p) p.with[r.other as string] = r.at as number;
  }
  return users;
}

const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const played = (g: Partial<Played> | null) => !!g && typeof g.title === "string" && num(g.ms) && num(g.sessions) && num(g.last);
const sitting = (r: Partial<Session> | null) => !!r && typeof r.key === "string" && typeof r.title === "string" && num(r.start) && num(r.end);
const ids = (list: unknown) => (Array.isArray(list) ? [...new Set(list.filter((id) => typeof id === "string" && USER.test(id)))] : []);

/** The old social.json, once (when it can't be read, it isn't marked: tried again at the next start). */
function importJson(db: Database, dir: string) {
  const file = join(dir, "social.json");
  let old: Record<string, Partial<Profile>> = {};
  if (existsSync(file)) {
    try {
      old = JSON.parse(readFileSync(file, "utf8")).users ?? {};
    } catch (err) {
      console.error(`${file} can't be read; not imported (it's tried again at the next start):`, err);
      return;
    }
  }
  importOnce(db, "social.json", () => {
    const users: Record<string, Profile> = {};
    for (const [id, p] of Object.entries(old)) {
      if (!USER.test(id) || !p || typeof p.name !== "string") continue;
      const t = typeof p.since === "number" ? p.since : Date.now();
      const b = blank(p.name, t);
      users[id] = {
        ...b,
        seen: typeof p.seen === "number" ? p.seen : t,
        status: STATUSES.has(p.status as Status) ? (p.status as Status) : "online",
        note: typeof p.note === "string" ? p.note : "",
        games: Object.fromEntries(Object.entries(p.games ?? {}).filter(([, g]) => played(g))),
        recent: (Array.isArray(p.recent) ? p.recent : []).filter(sitting).slice(0, MOST_RECENT),
        friends: ids(p.friends),
        incoming: ids(p.incoming),
        outgoing: ids(p.outgoing),
        with: Object.fromEntries(Object.entries(p.with ?? {}).filter(([o, at]) => USER.test(o) && Number.isFinite(at))),
      };
    }
    store(db, users, Object.keys(users), { keep: true });
  });
}

export function createSocial(dir: string, now: () => number = () => Date.now()) {
  const db = openDb(dir);
  importJson(db, dir);
  const users = load(db);
  /** each one's last beat, for the time since it */
  const beats = new Map<string, { key: string; at: number }>();
  const invites = new Map<string, Invite[]>();
  /** when each one's "seen" was last written (the home looks every 2 s, pushed or polled: once a minute is enough) */
  const kept = new Map<string, number>();
  /** the profiles changed since the last write */
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function save(...ids: string[]) {
    for (const id of ids) dirty.add(id);
    if (timer) return;
    timer = setTimeout(flush, SAVE_MS);
  }
  /** Writes now (tests, and the timer). */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const ids = [...dirty];
    dirty.clear();
    try {
      db.transaction(() => store(db, users, ids))();
    } catch (err) {
      // (tried again with the next change)
      for (const id of ids) dirty.add(id);
      console.error("social: not written:", err);
    }
    return Promise.resolve();
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
    /** Shutting down (index.ts): a change still waiting for its timer written now (the database writes at once). */
    settle(): Promise<void> {
      return timer ? flush() : Promise.resolve();
    },

    /** The home open (each of its looks, homefeed.ts or the poll): their profile, with the name the pass has now. */
    seen(pass: { id: string; name: string }) {
      if (!USER.test(pass.id)) return;
      const t = now();
      const fresh = !users[pass.id];
      const p = (users[pass.id] ??= blank(pass.name, t));
      if (fresh || p.name !== pass.name || t - (kept.get(pass.id) ?? 0) > 60_000) {
        kept.set(pass.id, t);
        save(pass.id);
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
        return save(pass.id);
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
      save(pass.id);
    },

    /** Status and the note under the name ("procurando alguém pra jogar"). */
    setStatus(id: string, s: { status?: unknown; note?: unknown }): boolean {
      const p = get(id);
      if (!p || (s.status !== undefined && !STATUSES.has(s.status as Status)) || (s.note !== undefined && typeof s.note !== "string")) return false;
      if (s.status !== undefined) p.status = s.status as Status;
      if (typeof s.note === "string") p.note = s.note.trim().slice(0, NOTE_MAX);
      save(id);
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
        save(me, them);
        return "friends";
      }
      if (a.outgoing.includes(them)) return "already";
      if (b.incoming.length >= MOST_FRIENDS) return "bad";
      a.outgoing.push(them);
      b.incoming.push(me);
      save(me, them);
      return "sent";
    },

    /** Unfriend, decline or cancel: whatever there was between the two, gone on both sides. */
    remove(me: string, them: string): boolean {
      const a = get(me), b = get(them);
      if (!a || !b) return false;
      for (const [x, id] of [[a, them], [b, me]] as const) for (const list of [x.friends, x.incoming, x.outgoing]) drop(list, id);
      save(me, them);
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
     * For the home (its feed and its poll): my status, my friends (each with whether they're online: `online(id)`, presence.ts), the
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
