/**
 * The online relay (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md): when WebRTC can't link a PS2
 * game's host and player 2, their picture, sound and controller go through here, over the app's WebSocket
 * (routes.ts, ps2/<id>/room/<code>/relay). It only passes packets on (page/relaywire.ts), by kind and only the
 * right way, and keeps nothing but what's in flight:
 *
 *   - one pair per guest of a room (the host opens one socket for each, `me` naming the guest): the same guest (or the
 *     host) again takes its place; a guest that only watches can't send a controller (PAD is dropped);
 *   - the guest's last HELLO waits for a host that isn't there yet, or comes again;
 *   - a guest falling behind (over SLOW_BYTES waiting to go out) loses video and audio until the next key frame, and
 *     the host is asked for one, rather than lagging further and further;
 *   - either leaving, the other hears BYE (and a guest without its host is closed).
 */
import { AUDIO, encode, FROM_GUEST, FROM_HOST, HELLO, isKeyVideo, PAD, VIDEO } from "../page/relaywire";

export interface RelaySocket {
  send(data: Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export const MAX_PACKET = 1 << 20;
export const SLOW_BYTES = 1 << 20;

interface Pair {
  host?: RelaySocket;
  guest?: { ws: RelaySocket; me: string };
  hello?: Uint8Array;
  /** The guest is behind: video and audio wait for a key frame. */
  skipping: boolean;
  /** The guest only watches. */
  watch?: boolean;
}

const key = encode({ t: "key" });
const bye = encode({ t: "bye" });

export class Relay {
  private rooms = new Map<string, Pair>();
  private sockets = new Map<RelaySocket, { room: string; role: "host" | "guest" }>();

  /** `me`: the guest, either side (the host's socket for that guest). */
  open(ws: RelaySocket, code: string, role: "host" | "guest", me: string, watch = false): void {
    const room = `${code}/${me}`;
    const pair = this.rooms.get(room) ?? { skipping: false };
    this.rooms.set(room, pair);
    if (role === "host") {
      if (pair.host) this.drop(pair.host);
      pair.host = ws;
      if (pair.hello) ws.send(pair.hello);
    } else {
      if (pair.guest) this.drop(pair.guest.ws);
      pair.guest = { ws, me };
      pair.skipping = false;
      pair.watch = watch;
    }
    this.sockets.set(ws, { room, role });
  }

  message(ws: RelaySocket, data: string | Uint8Array): void {
    const at = this.sockets.get(ws);
    const pair = at && this.rooms.get(at.room);
    if (!at || !pair || typeof data === "string" || data.length === 0 || data.length > MAX_PACKET) return;
    const kind = data[0]!;
    if (at.role === "guest") {
      if (!FROM_GUEST.has(kind) || (pair.watch && kind === PAD)) return;
      if (kind === HELLO) pair.hello = data.slice();
      pair.host?.send(data);
      return;
    }
    if (!FROM_HOST.has(kind) || !pair.guest) return;
    const guest = pair.guest.ws;
    if (kind === VIDEO || kind === AUDIO) {
      const slow = guest.getBufferedAmount() > SLOW_BYTES;
      if (pair.skipping && isKeyVideo(data) && !slow) pair.skipping = false;
      else if (pair.skipping) return;
      else if (slow) {
        pair.skipping = true;
        ws.send(key);
        return;
      }
    }
    guest.send(data);
  }

  close(ws: RelaySocket): void {
    const at = this.sockets.get(ws);
    if (!at) return;
    this.sockets.delete(ws);
    const pair = this.rooms.get(at.room);
    if (!pair) return;
    if (at.role === "host" && pair.host === ws) {
      pair.host = undefined;
      if (pair.guest) {
        pair.guest.ws.send(bye);
        this.drop(pair.guest.ws);
        pair.guest = undefined;
      }
    } else if (at.role === "guest" && pair.guest?.ws === ws) {
      pair.guest = undefined;
      pair.hello = undefined;
      pair.host?.send(bye);
    }
    if (!pair.host && !pair.guest) this.rooms.delete(at.room);
  }

  /** A socket replaced or left without its partner: forgotten, then closed. */
  private drop(ws: RelaySocket) {
    this.sockets.delete(ws);
    ws.close();
  }
}

