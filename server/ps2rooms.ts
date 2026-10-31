/**
 * Online for the PS2 games: the signalling of the ps2-web-recomp page's own rooms (a port of scripts/serve.py's
 * /room), in this process's memory. The host runs the game and streams it over WebRTC; a guest opens the same page
 * with ?join=<code> and its controller becomes player 2. All this carries is their setting-up messages:
 *
 *   POST room                      a new room (its code), made by the host
 *   POST room/<code>/<to>          a JSON message into someone's inbox
 *   GET  room/<code>/<me>?after=N  the messages past N, waiting up to 20 s for one (long-poll)
 *
 * Rooms are listed per game in the home, so friends join from there. Clock and timers are injectable for tests.
 */

export const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_IDLE_MS = 3_600_000;
/** Under Bun.serve's default idle timeout (10 s), which would cut a longer wait. */
export const WAIT_MS = 8_000;
export const MESSAGE_MAX = 65_536;
/** A guest not heard from for this long has gone: the room shows as free again (a playing guest says "here"). */
export const GUEST_QUIET_MS = 30_000;
/** A host that stopped polling for this long closed the game: the room goes. */
export const HOST_QUIET_MS = 30_000;
export const INBOX = /^[a-z0-9]{1,16}$/;

type Messages = { messages: unknown[]; next: number };

interface Waiter {
  me: string;
  after: number;
  done: (m: Messages | null) => void;
  timer: unknown;
}

interface Room {
  game: string;
  host: string;
  hostId: string;
  hostSeen: number;
  since: number;
  seen: number;
  inboxes: Map<string, unknown[]>;
  waiters: Set<Waiter>;
  /** guests that joined and haven't said bye, by when last heard from */
  guests: Map<string, number>;
}

export class Ps2Rooms {
  private rooms = new Map<string, Room>();

  constructor(
    private now: () => number = () => Date.now(),
    private random: () => number = Math.random,
    private setTimer: typeof setTimeout = setTimeout,
    private clearTimer: typeof clearTimeout = clearTimeout,
  ) {}

  create(game: string, host: { id: string; name: string }): string {
    this.sweep();
    let code = "";
    do code = Array.from({ length: 6 }, () => ROOM_LETTERS[Math.floor(this.random() * ROOM_LETTERS.length)]).join("");
    while (this.rooms.has(code));
    const t = this.now();
    this.rooms.set(code, { game, host: host.name, hostId: host.id, hostSeen: t, since: t, seen: t, inboxes: new Map(), waiters: new Set(), guests: new Map() });
    return code;
  }

  /** false: no such room */
  post(code: string, to: string, message: unknown): boolean {
    const room = this.room(code);
    if (!room) return false;
    const m = message as { type?: unknown; from?: unknown };
    if (to === "host" && typeof m?.from === "string") {
      // a playing guest's heartbeat: keeps the room busy, nothing for the host to read
      if (m.type === "here") {
        if (room.guests.has(m.from)) room.guests.set(m.from, room.seen);
        return true;
      }
      if (m.type === "join") room.guests.set(m.from, room.seen);
      else if (m.type === "bye") room.guests.delete(m.from);
      else if (room.guests.has(m.from)) room.guests.set(m.from, room.seen);
    }
    const inbox = room.inboxes.get(to) ?? [];
    inbox.push(message);
    room.inboxes.set(to, inbox);
    for (const w of [...room.waiters]) if (w.me === to && inbox.length > w.after) this.wake(room, w);
    return true;
  }

  /** null: the room is gone */
  wait(code: string, me: string, after: number, ms = WAIT_MS): Promise<Messages | null> {
    const room = this.room(code);
    if (!room) return Promise.resolve(null);
    if (me === "host") room.hostSeen = room.seen;
    if (room.guests.has(me)) room.guests.set(me, room.seen);
    const inbox = room.inboxes.get(me) ?? [];
    if (inbox.length > after) return Promise.resolve({ messages: inbox.slice(after), next: inbox.length });
    return new Promise((done) => {
      const w: Waiter = { me, after, done, timer: undefined };
      w.timer = this.setTimer(() => this.wake(room, w), ms);
      room.waiters.add(w);
    });
  }

  /** The host leaving: its room goes, and whoever waits on it hears so. Only its host may. */
  close(code: string, by: string): boolean {
    const room = this.rooms.get(code);
    if (!room || room.hostId !== by) return false;
    this.drop(code, room);
    return true;
  }

  /** Who may open the room's relay as its host (relay.ts): its host's id; null, no such room. */
  hostOf(code: string): string | null {
    this.sweep();
    return this.rooms.get(code)?.hostId ?? null;
  }

  /** Who may open the relay as player 2: a guest that joined and hasn't said bye. */
  hasGuest(code: string, me: string): boolean {
    this.sweep();
    return this.rooms.get(code)?.guests.has(me) ?? false;
  }

  list(game: string): { code: string; host: string; since: number; busy: boolean }[] {
    this.sweep();
    const t = this.now();
    return [...this.rooms]
      .filter(([, r]) => r.game === game)
      .map(([code, r]) => ({ code, host: r.host, since: r.since, busy: [...r.guests.values()].some((seen) => t - seen <= GUEST_QUIET_MS) }));
  }

  private wake(room: Room, w: Waiter) {
    if (!room.waiters.delete(w)) return;
    this.clearTimer(w.timer as ReturnType<typeof setTimeout>);
    const inbox = room.inboxes.get(w.me) ?? [];
    w.done({ messages: inbox.slice(w.after), next: Math.max(w.after, inbox.length) });
  }

  private room(code: string): Room | undefined {
    this.sweep();
    const room = this.rooms.get(code);
    if (room) room.seen = this.now();
    return room;
  }

  private drop(code: string, r: Room) {
    this.rooms.delete(code);
    for (const w of r.waiters) {
      this.clearTimer(w.timer as ReturnType<typeof setTimeout>);
      w.done(null);
    }
  }

  /** Rooms nobody touched for an hour, or whose host stopped polling, go; whoever waits on one hears it's gone. */
  private sweep() {
    const t = this.now();
    for (const [code, r] of this.rooms) if (t - r.seen > ROOM_IDLE_MS || t - r.hostSeen > HOST_QUIET_MS) this.drop(code, r);
  }
}
