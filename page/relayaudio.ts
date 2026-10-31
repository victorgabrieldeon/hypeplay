// The online relay's sound (spec: docs/superpowers/specs/2026-10-31-online-rele-design.md): the host's game sound as
// PCM blocks for the Opus encoder (relayhost.ts). The AudioWorklet modules are strings, loaded from Blob URLs (the
// game's page has no file of its own for them).

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
