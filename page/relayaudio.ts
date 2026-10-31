// The online relay's sound (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md): the host's game sound as
// PCM blocks for the Opus encoder (relayhost.ts), and player 2's speaker for what it decodes (relayguest.ts). The
// AudioWorklet modules are strings, loaded from Blob URLs (the pages have no file of their own for them).

const RATE = 48000;
/** 20 ms at 48 kHz: one Opus packet. */
const BLOCK = 960;

const CAPTURE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(${BLOCK} * 2);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const l = input[0];
    const r = input[1] || input[0];
    for (let i = 0; i < l.length; i++) {
      this.block[this.n * 2] = l[i];
      this.block[this.n * 2 + 1] = r[i];
      if (++this.n === ${BLOCK}) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(${BLOCK} * 2);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("hypeplay-capture", Capture);
`;

async function load(ctx: AudioContext, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The stream's sound in blocks of BLOCK frames, 48 kHz, stereo interleaved (a mono stream is doubled). Returns how to
 * stop. (Its own context at 48 kHz, whatever the game's: Opus wants 48 kHz.)
 */
export async function captureAudio(stream: MediaStream, onPcm: (pcm: Float32Array<ArrayBuffer>, frames: number) => void): Promise<() => void> {
  const ctx = new AudioContext({ sampleRate: RATE });
  await load(ctx, CAPTURE);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "hypeplay-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => onPcm(e.data, BLOCK);
  // (pulled by the graph only when it leads somewhere: it writes nothing, so the destination hears silence)
  source.connect(node).connect(ctx.destination);
  void ctx.resume().catch(() => {});
  return () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    void ctx.close().catch(() => {});
  };
}

/** Player 2's buffer: sound starts (and starts again after running dry) with 60 ms queued; past 200 ms, the oldest goes. */
const TARGET = (RATE * 60) / 1000;
const MOST = (RATE * 200) / 1000;

const PLAYER = `
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.at = 0;
    this.queued = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      this.queue.push(e.data);
      this.queued += e.data.length / 2;
      while (this.queued > ${MOST} && this.queue.length > 1) {
        const old = this.queue.shift();
        this.queued -= old.length / 2 - this.at;
        this.at = 0;
      }
    };
  }
  process(inputs, outputs) {
    const l = outputs[0][0];
    const r = outputs[0][1] || l;
    if (!this.playing && this.queued >= ${TARGET}) this.playing = true;
    for (let i = 0; i < l.length; i++) {
      const block = this.playing ? this.queue[0] : undefined;
      if (!block) {
        l[i] = 0;
        r[i] = 0;
        this.playing = false;
        continue;
      }
      l[i] = block[this.at * 2];
      r[i] = block[this.at * 2 + 1];
      this.queued--;
      if (++this.at * 2 >= block.length) {
        this.queue.shift();
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor("hypeplay-player", Player);
`;

/**
 * Player 2's speaker: blocks of 48 kHz stereo interleaved PCM in, played with a small buffer. Silent until resume()
 * (the browser wants a click first: the page's "Ligar o som").
 */
export async function playAudio(): Promise<{ push(pcm: Float32Array<ArrayBuffer>, frames: number): void; resume(): Promise<void>; close(): void }> {
  const ctx = new AudioContext({ sampleRate: RATE });
  await load(ctx, PLAYER);
  const node = new AudioWorkletNode(ctx, "hypeplay-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  return {
    push: (pcm) => node.port.postMessage(pcm, [pcm.buffer]),
    resume: () => ctx.resume(),
    close: () => void ctx.close().catch(() => {}),
  };
}
