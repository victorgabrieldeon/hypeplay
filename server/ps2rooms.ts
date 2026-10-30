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
export const WAIT_MS = 20_000;
export const MESSAGE_MAX = 65_536;
/** A guest not heard from for this long has gone: the room shows as free again. */
export const GUEST_QUIET_MS = 30_000;
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
    this.rooms.set(code, { game, host: host.name, since: t, seen: t, inboxes: new Map(), waiters: new Set(), guests: new Map() });
    return code;
  }

  /** false: no such room */
  post(code: string, to: string, message: unknown): boolean {
    const room = this.room(code);
    if (!room) return false;
    const m = message as { type?: unknown; from?: unknown };
    if (to === "host" && typeof m?.from === "string") {
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
    if (room.guests.has(me)) room.guests.set(me, room.seen);
    const inbox = room.inboxes.get(me) ?? [];
    if (inbox.length > after) return Promise.resolve({ messages: inbox.slice(after), next: inbox.length });
    return new Promise((done) => {
      const w: Waiter = { me, after, done, timer: undefined };
      w.timer = this.setTimer(() => this.wake(room, w), ms);
      room.waiters.add(w);
    });
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

  /** Rooms nobody touched for an hour go; whoever was waiting on one hears it's gone. */
  private sweep() {
    const t = this.now();
    for (const [code, r] of this.rooms) {
      if (t - r.seen <= ROOM_IDLE_MS) continue;
      this.rooms.delete(code);
      for (const w of r.waiters) {
        this.clearTimer(w.timer as ReturnType<typeof setTimeout>);
        w.done(null);
      }
    }
  }
}
