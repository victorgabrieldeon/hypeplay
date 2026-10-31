// The online relay's packets (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md): what the host and player
// 2 send each other through the server (server/relay.ts) when WebRTC can't link them. Binary; the first byte is the
// kind. HELLO, CONFIG and PAD carry JSON; VIDEO a flags byte (bit 0: key frame) and a u32 time in ms; AUDIO the time;
// KEY and BYE nothing more.

export const HELLO = 1;
export const CONFIG = 2;
export const VIDEO = 3;
export const AUDIO = 4;
export const PAD = 5;
export const KEY = 6;
export const BYE = 7;
/** What each side may send: the server drops the rest. */
export const FROM_HOST: ReadonlySet<number> = new Set([CONFIG, VIDEO, AUDIO, BYE]);
export const FROM_GUEST: ReadonlySet<number> = new Set([HELLO, PAD, KEY, BYE]);

/** In the host's order of preference: H.264 (Annex B, so no description), then VP8. */
export const VIDEO_CODECS = ["avc1.42E01F", "vp8"] as const;

export type VideoConfig = { codec: string; width: number; height: number };
export type AudioConfig = { codec: "opus"; sampleRate: 48000; numberOfChannels: 2 };

export type Packet =
  | { t: "hello"; video: string[]; audio: string[] }
  | { t: "config"; video: VideoConfig; audio: AudioConfig | null }
  | { t: "video"; key: boolean; time: number; data: Uint8Array }
  | { t: "audio"; time: number; data: Uint8Array }
  | { t: "pad"; pad: unknown }
  | { t: "key" }
  | { t: "bye" };

const text = new TextEncoder();
const untext = new TextDecoder();

function withJson(kind: number, value: unknown): Uint8Array<ArrayBuffer> {
  const body = text.encode(JSON.stringify(value));
  const out = new Uint8Array(1 + body.length);
  out[0] = kind;
  out.set(body, 1);
  return out;
}

function timed(kind: number, head: number[], time: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const at = 1 + head.length;
  const out = new Uint8Array(at + 4 + data.length);
  out[0] = kind;
  out.set(head, 1);
  new DataView(out.buffer).setUint32(at, time >>> 0);
  out.set(data, at + 4);
  return out;
}

export function encode(p: Packet): Uint8Array<ArrayBuffer> {
  switch (p.t) {
    case "hello":
      return withJson(HELLO, { video: p.video, audio: p.audio });
    case "config":
      return withJson(CONFIG, { video: p.video, audio: p.audio });
    case "pad":
      return withJson(PAD, p.pad);
    case "video":
      return timed(VIDEO, [p.key ? 1 : 0], p.time, p.data);
    case "audio":
      return timed(AUDIO, [], p.time, p.data);
    case "key":
      return Uint8Array.of(KEY);
    case "bye":
      return Uint8Array.of(BYE);
  }
}

function json(b: Uint8Array): unknown {
  try {
    return JSON.parse(untext.decode(b.subarray(1)));
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function decode(b: Uint8Array): Packet | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (b[0]) {
    case HELLO: {
      const v = json(b) as { video?: unknown; audio?: unknown } | undefined;
      return v && strings(v.video) && strings(v.audio) ? { t: "hello", video: v.video, audio: v.audio } : null;
    }
    case CONFIG: {
      const v = json(b) as { video?: VideoConfig; audio?: AudioConfig | null } | undefined;
      const ok = v?.video && typeof v.video.codec === "string" && Number.isInteger(v.video.width) && Number.isInteger(v.video.height);
      return ok ? { t: "config", video: v.video!, audio: v.audio ?? null } : null;
    }
    case PAD: {
      const pad = json(b);
      return pad === undefined ? null : { t: "pad", pad };
    }
    case VIDEO:
      return b.length < 6 ? null : { t: "video", key: (b[1]! & 1) === 1, time: view.getUint32(2), data: b.subarray(6) };
    case AUDIO:
      return b.length < 5 ? null : { t: "audio", time: view.getUint32(1), data: b.subarray(5) };
    case KEY:
      return { t: "key" };
    case BYE:
      return { t: "bye" };
    default:
      return null;
  }
}

/** For the server: a VIDEO packet carrying a key frame, without reading the rest. */
export const isKeyVideo = (b: Uint8Array) => b.length >= 2 && b[0] === VIDEO && (b[1]! & 1) === 1;

/** The video codec: the first of VIDEO_CODECS that player 2 can play and the host can make; null, none in common. */
export async function pickCodec(guest: readonly string[], hostCan: (codec: string) => Promise<boolean>): Promise<string | null> {
  for (const codec of VIDEO_CODECS) if (guest.includes(codec) && (await hostCan(codec).catch(() => false))) return codec;
  return null;
}
