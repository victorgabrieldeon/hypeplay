// Player 2's side of the relay (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md), for watch.ts when
// WebRTC can't link it to the host, or isn't there (inside Discord): the host's game comes over the app's WebSocket
// (server/relay.ts), decoded with WebCodecs onto a canvas, the sound into relayaudio.ts' speaker; this person's
// controller goes back the same way.
import { playAudio } from "./relayaudio";
import { decode, encode, RESTART, VIDEO_CODECS, type Packet } from "./relaywire";

/** The controller goes out when it changes, and this often all the same (it also keeps the socket alive). */
const PAD_EVERY_MS = 100;

/** Wall-clock ms as a u32, as the host stamps its frames (relayhost.ts). */
const stamp = () => Math.round(performance.timeOrigin + performance.now()) >>> 0;

export function joinRelay(o: {
  url: string;
  canvas: HTMLCanvasElement;
  pad(): unknown;
  onLinked(): void;
  /** "restart": the server is going down for a deploy (RESTART), and comes back */
  onStuck(why: "closed" | "no-decoder" | "restart"): void;
  onSound(): void;
}): { stop(): void; unmute(): Promise<void>; lag(): number | null } {
  const ws = new WebSocket(o.url);
  ws.binaryType = "arraybuffer";
  const ctx = o.canvas.getContext("2d")!;
  let decoder: VideoDecoder | null = null;
  let sound: AudioDecoder | null = null;
  let speaker: Awaited<ReturnType<typeof playAudio>> | null = null;
  let needKey = true;
  let linked = false;
  let heard = false;
  let ended = false;
  let lag: number | null = null;
  let padTimer = 0;
  let lastPad = "";
  let lastSent = 0;

  const send = (p: Packet) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(p));
  };

  function sendPad() {
    const pad = o.pad();
    const json = JSON.stringify(pad);
    const now = performance.now();
    if (json === lastPad && now - lastSent < PAD_EVERY_MS) return;
    lastPad = json;
    lastSent = now;
    send({ t: "pad", pad });
  }

  async function hello() {
    const video: string[] = [];
    if (typeof VideoDecoder === "function")
      for (const codec of VIDEO_CODECS)
        if ((await VideoDecoder.isConfigSupported({ codec, codedWidth: 640, codedHeight: 480 }).catch(() => null))?.supported) video.push(codec);
    if (!video.length) return end("no-decoder");
    const opus = { codec: "opus", sampleRate: 48000, numberOfChannels: 2 };
    const audio = typeof AudioDecoder === "function" && (await AudioDecoder.isConfigSupported(opus).catch(() => null))?.supported ? ["opus"] : [];
    send({ t: "hello", video, audio });
    padTimer = window.setInterval(sendPad, 1000 / 60);
  }

  /** The host's CONFIG, the first or again (a host that came back): the decoders start over, from a key frame. */
  function configure(c: Extract<Packet, { t: "config" }>) {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = new VideoDecoder({
      output: (frame) => {
        if (o.canvas.width !== frame.displayWidth || o.canvas.height !== frame.displayHeight) {
          o.canvas.width = frame.displayWidth;
          o.canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        lag = (stamp() - frame.timestamp / 1000) >>> 0;
        // (on the canvas too, for whoever looks: data-lag, in ms)
        o.canvas.dataset.lag = String(lag);
        frame.close();
        if (!linked) {
          linked = true;
          o.onLinked();
        }
      },
      error: () => {
        // (lost: ask for a key frame and start over from it)
        send({ t: "key" });
        configure(c);
      },
    });
    decoder.configure({ codec: c.video.codec, codedWidth: c.video.width, codedHeight: c.video.height, optimizeForLatency: true });
    needKey = true;
    if (sound && sound.state !== "closed") sound.close();
    sound = null;
    if (!c.audio || typeof AudioDecoder !== "function") return;
    sound = new AudioDecoder({
      output: (data) => {
        const n = data.numberOfFrames;
        const left = new Float32Array(n);
        const right = new Float32Array(n);
        data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
        data.copyTo(right, { planeIndex: data.numberOfChannels > 1 ? 1 : 0, format: "f32-planar" });
        data.close();
        const pcm = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          pcm[i * 2] = left[i]!;
          pcm[i * 2 + 1] = right[i]!;
        }
        speaker?.push(pcm, n);
        // (for whoever looks: data-heard, the sound blocks that came)
        o.canvas.dataset.heard = String(Number(o.canvas.dataset.heard ?? 0) + 1);
        if (!heard) {
          heard = true;
          o.onSound();
        }
      },
      error: () => {},
    });
    sound.configure({ codec: c.audio.codec, sampleRate: c.audio.sampleRate, numberOfChannels: c.audio.numberOfChannels });
    if (!speaker) void playAudio().then((s) => (ended ? s.close() : (speaker = s)), () => {});
  }

  ws.onopen = () => void hello();
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const p = decode(new Uint8Array(e.data));
    if (!p) return;
    if (p.t === "config") configure(p);
    else if (p.t === "video") {
      if (!decoder || decoder.state !== "configured" || (needKey && !p.key)) return;
      needKey = false;
      decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.time * 1000, data: p.data }));
    } else if (p.t === "audio") {
      if (sound?.state === "configured") sound.decode(new EncodedAudioChunk({ type: "key", timestamp: p.time * 1000, data: p.data }));
    } else if (p.t === "bye") end("closed");
  };
  ws.onclose = (e) => end(e.code === RESTART ? "restart" : "closed");

  /** Everything stops; `why`, when it wasn't asked for. */
  function end(why?: "closed" | "no-decoder" | "restart") {
    if (ended) return;
    ended = true;
    clearInterval(padTimer);
    if (decoder && decoder.state !== "closed") decoder.close();
    if (sound && sound.state !== "closed") sound.close();
    speaker?.close();
    if (ws.readyState <= WebSocket.OPEN) ws.close();
    if (why) o.onStuck(why);
  }

  return {
    stop() {
      send({ t: "bye" });
      end();
    },
    unmute: async () => {
      await speaker?.resume();
      // (and data-speaker, whether the speaker plays)
      o.canvas.dataset.speaker = speaker?.state() ?? "none";
    },
    lag: () => lag,
  };
}
