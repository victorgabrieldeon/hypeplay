import { expect, test } from "bun:test";
import { AUDIO, BYE, CONFIG, encode, HELLO, KEY, PAD, VIDEO } from "../page/relaywire";
import { MAX_PACKET, Relay, SLOW_BYTES, type RelaySocket } from "./relay";

class Fake implements RelaySocket {
  got: Uint8Array[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  buffered = 0;
  send(data: Uint8Array) {
    this.got.push(data);
    return data.length;
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason];
  }
  getBufferedAmount() {
    return this.buffered;
  }
  /** The kinds received, in order. */
  get kinds() {
    return this.got.map((b) => b[0]);
  }
}

const video = (key: boolean) => encode({ t: "video", key, time: 1, data: Uint8Array.of(1, 2) });
const audio = encode({ t: "audio", time: 1, data: Uint8Array.of(3) });
const hello = encode({ t: "hello", video: ["vp8"], audio: ["opus"] });

function pair(watch = false) {
  const relay = new Relay();
  const host = new Fake();
  const guest = new Fake();
  relay.open(host, "ABCDEF", "host", "g1");
  relay.open(guest, "ABCDEF", "guest", "g1", watch);
  return { relay, host, guest };
}

test("host to guest: config, video, audio and bye; guest to host: hello, pad, key and bye", () => {
  const { relay, host, guest } = pair();
  relay.message(host, encode({ t: "config", video: { codec: "vp8", width: 640, height: 480 }, audio: null }));
  relay.message(host, video(true));
  relay.message(host, audio);
  relay.message(guest, hello);
  relay.message(guest, encode({ t: "pad", pad: { b: [1] } }));
  relay.message(guest, encode({ t: "key" }));
  // the wrong way: nobody gets them
  relay.message(guest, video(true));
  relay.message(host, encode({ t: "pad", pad: {} }));
  expect(guest.kinds).toEqual([CONFIG, VIDEO, AUDIO]);
  expect(host.kinds).toEqual([HELLO, PAD, KEY]);
  relay.message(host, encode({ t: "bye" }));
  relay.message(guest, encode({ t: "bye" }));
  expect(guest.kinds.at(-1)).toBe(BYE);
  expect(host.kinds.at(-1)).toBe(BYE);
});

test("what isn't a packet, or is over 1 MB, is dropped and nobody falls", () => {
  const { relay, host, guest } = pair();
  const big = new Uint8Array(MAX_PACKET + 1);
  big[0] = VIDEO;
  for (const bad of [Uint8Array.of(), Uint8Array.of(99), "olá", big]) relay.message(host, bad);
  for (const bad of [Uint8Array.of(), Uint8Array.of(99), "olá"]) relay.message(guest, bad);
  expect(guest.got).toEqual([]);
  expect(host.got).toEqual([]);
  expect(host.closed).toBeNull();
  expect(guest.closed).toBeNull();
});

test("a guest that came first: its hello reaches the host when it opens", () => {
  const relay = new Relay();
  const guest = new Fake();
  relay.open(guest, "ABCDEF", "guest", "g1");
  relay.message(guest, hello);
  const host = new Fake();
  relay.open(host, "ABCDEF", "host", "g1");
  expect(host.got).toEqual([hello]);
});

test("a host that comes again gets the guest's hello again", () => {
  const { relay, host, guest } = pair();
  relay.message(guest, hello);
  expect(host.got).toEqual([hello]);
  const again = new Fake();
  relay.open(again, "ABCDEF", "host", "g1");
  expect(host.closed).not.toBeNull();
  expect(again.got).toEqual([hello]);
  relay.message(again, video(true));
  expect(guest.kinds).toEqual([VIDEO]);
});

test("a pair per guest: another guest never sees this one's stream; the same one again takes its place", () => {
  const { relay, host, guest } = pair();
  const other = new Fake();
  relay.open(other, "ABCDEF", "guest", "g2");
  expect(other.closed).toBeNull();
  relay.message(host, video(true));
  expect(other.got).toEqual([]);
  const back = new Fake();
  relay.open(back, "ABCDEF", "guest", "g1");
  expect(guest.closed).not.toBeNull();
  relay.message(host, video(true));
  expect(back.kinds).toEqual([VIDEO]);
});

test("a watcher gets the stream but its controller never reaches the host", () => {
  const { relay, host, guest } = pair(true);
  relay.message(guest, hello);
  relay.message(guest, encode({ t: "pad", pad: { b: [1] } }));
  relay.message(guest, encode({ t: "key" }));
  expect(host.kinds).toEqual([HELLO, KEY]);
  relay.message(host, video(true));
  expect(guest.kinds).toEqual([VIDEO]);
});

test("a slow guest loses video and audio until a key frame, and the host is asked for one", () => {
  const { relay, host, guest } = pair();
  guest.buffered = SLOW_BYTES + 1;
  relay.message(host, video(false));
  relay.message(host, audio);
  expect(guest.got).toEqual([]);
  expect(host.kinds).toEqual([KEY]);
  guest.buffered = 0;
  relay.message(host, video(false));
  relay.message(host, audio);
  expect(guest.got).toEqual([]);
  relay.message(host, video(true));
  relay.message(host, video(false));
  relay.message(host, audio);
  expect(guest.kinds).toEqual([VIDEO, VIDEO, AUDIO]);
  // (one KEY asked for the whole stretch)
  expect(host.kinds).toEqual([KEY]);
});

test("either leaving: the other hears bye", () => {
  const a = pair();
  a.relay.close(a.host);
  expect(a.guest.kinds).toEqual([BYE]);
  expect(a.guest.closed).not.toBeNull();
  const b = pair();
  b.relay.close(b.guest);
  expect(b.host.kinds).toEqual([BYE]);
  expect(b.host.closed).toBeNull();
});
