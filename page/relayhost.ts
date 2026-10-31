// The online host's side of the relay (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md), for stream.ts
// when WebRTC can't link it to player 2: the game's picture (its canvas, through a hidden <video>, 640×480) and sound
// encoded with WebCodecs and sent over the app's WebSocket (server/relay.ts); player 2's controller comes back the
// same way. The codec is the first both sides can (relaywire.ts' pickCodec).
import { captureAudio } from "./relayaudio";
import { decode, encode, pickCodec, type AudioConfig, type Packet, type VideoConfig } from "./relaywire";

const WIDTH = 640;
const HEIGHT = 480;
const FPS = 60;
const BITRATE = 2_500_000;
/** A key frame every 2 s at 60 fps (and whenever player 2 asks). */
const KEY_EVERY = 120;
const AUDIO: AudioConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 2 };
const AUDIO_BITRATE = 96_000;

export const canRelay = () => typeof VideoEncoder === "function";

const videoConfig = (codec: string): VideoEncoderConfig => ({
  codec,
  width: WIDTH,
  height: HEIGHT,
  bitrate: BITRATE,
  framerate: FPS,
  latencyMode: "realtime",
  // (H.264 in Annex B carries its own parameter sets: no description to send; the graphics card's encoder if any)
  ...(codec.startsWith("avc1") ? { avc: { format: "annexb" as const }, hardwareAcceleration: "prefer-hardware" as const } : {}),
});

/** Wall-clock ms, as a u32: the guest compares it with its own clock (the same machine's, in a test). */
const stamp = () => Math.round(performance.timeOrigin + performance.now()) >>> 0;

export function startRelay(o: {
  url: string;
  canvas: HTMLCanvasElement;
  audio: MediaStream | null;
  onPad(pad: unknown): void;
  onJoin(): void;
  onLeave(): void;
  onNoCodec(): void;
}): { stop(): void } {
  const ws = new WebSocket(o.url);
  ws.binaryType = "arraybuffer";
  let stopped = false;
  let joined = false;
  let config: Packet | null = null;
  let encoder: VideoEncoder | null = null;
  let sound: AudioEncoder | null = null;
  let stopSound: (() => void) | null = null;
  let video: HTMLVideoElement | null = null;
  let frames = 0;
  let wantKey = true;

  const send = (p: Packet) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(p));
  };

  function picture() {
    const v = (video = document.createElement("video"));
    v.muted = true;
    v.playsInline = true;
    // (the game's page hides everything else: this has to be shown, however small, for its frames to come)
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;visibility:visible !important";
    v.srcObject = o.canvas.captureStream(FPS);
    document.body.append(v);
    const off = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = off.getContext("2d")!;
    const tick = () => {
      if (stopped || !encoder) return;
      // (an encoder behind drops this frame instead of falling further back)
      if (encoder.state === "configured" && encoder.encodeQueueSize <= 2) {
        ctx.drawImage(v, 0, 0, WIDTH, HEIGHT);
        const frame = new VideoFrame(off, { timestamp: Math.round(performance.now() * 1000) });
        encoder.encode(frame, { keyFrame: wantKey || frames % KEY_EVERY === 0 });
        frame.close();
        wantKey = false;
        frames++;
      }
      v.requestVideoFrameCallback(tick);
    };
    void v.play().then(() => v.requestVideoFrameCallback(tick), () => {});
  }

  async function sounds(guestHas: string[]): Promise<AudioConfig | null> {
    if (!o.audio || typeof AudioEncoder !== "function" || !guestHas.includes("opus")) return null;
    const cfg = { ...AUDIO, bitrate: AUDIO_BITRATE };
    if (!(await AudioEncoder.isConfigSupported(cfg).catch(() => null))?.supported) return null;
    sound = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        send({ t: "audio", time: stamp(), data });
      },
      error: () => {},
    });
    sound.configure(cfg);
    let at = 0;
    stopSound = await captureAudio(o.audio, (pcm, n) => {
      if (sound?.state !== "configured") return;
      const data = new AudioData({ format: "f32", sampleRate: AUDIO.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: at, data: pcm });
      sound.encode(data);
      data.close();
      at += (n / AUDIO.sampleRate) * 1e6;
    });
    return AUDIO;
  }

  async function begin(video: string[], audio: string[]) {
    const codec = await pickCodec(video, (c) => VideoEncoder.isConfigSupported(videoConfig(c)).then((r) => !!r.supported, () => false));
    if (!codec) {
      o.onNoCodec();
      return end();
    }
    encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        send({ t: "video", key: chunk.type === "key", time: stamp(), data });
      },
      error: () => {
        wantKey = true;
      },
    });
    encoder.configure(videoConfig(codec));
    const v: VideoConfig = { codec, width: WIDTH, height: HEIGHT };
    config = { t: "config", video: v, audio: await sounds(audio) };
    send(config);
    wantKey = true;
    picture();
  }

  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const p = decode(new Uint8Array(e.data));
    if (!p) return;
    if (p.t === "hello") {
      // (player 2 again, say after reconnecting: its decoder starts over, from a key frame)
      if (joined) {
        if (config) send(config);
        wantKey = true;
        return;
      }
      joined = true;
      o.onJoin();
      void begin(p.video, p.audio);
    } else if (p.t === "pad") o.onPad(p.pad);
    else if (p.t === "key") wantKey = true;
    else if (p.t === "bye") end();
  };
  ws.onclose = () => end();

  /** Everything stops; player 2 has left (or the relay did). */
  function end() {
    if (stopped) return;
    stopped = true;
    encoder?.state !== "closed" && encoder?.close();
    sound?.state !== "closed" && sound?.close();
    stopSound?.();
    if (video) {
      for (const t of (video.srcObject as MediaStream | null)?.getTracks() ?? []) t.stop();
      video.remove();
    }
    if (ws.readyState <= WebSocket.OPEN) ws.close();
    o.onLeave();
  }

  return {
    stop() {
      send({ t: "bye" });
      end();
    },
  };
}
