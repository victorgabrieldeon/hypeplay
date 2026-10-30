import { expect, test } from "bun:test";
import { installVolume } from "./volume";

/** Just enough of WebAudio to see where things connect. */
function fakeAudio() {
  class AudioNode {
    out = new Set<AudioNode>();
    constructor(readonly context: Ctx) {}
    connect(to: AudioNode) {
      this.out.add(to);
      return to;
    }
    disconnect(to?: AudioNode) {
      if (to) this.out.delete(to);
      else this.out.clear();
    }
  }
  class AudioDestinationNode extends AudioNode {}
  class GainNode extends AudioNode {
    gain = { value: 1 };
  }
  class Ctx {
    destination = new AudioDestinationNode(this);
    createGain() {
      return new GainNode(this);
    }
  }
  return { AudioNode, AudioDestinationNode, GainNode, Ctx };
}

test("everything played goes through one gain per context, at the volume", () => {
  const a = fakeAudio();
  const vol = installVolume({ AudioNode: a.AudioNode, AudioDestinationNode: a.AudioDestinationNode } as never, 0.7);
  const ctx = new a.Ctx();
  const music = new a.AudioNode(ctx);
  const sfx = new a.AudioNode(ctx);
  music.connect(ctx.destination);
  sfx.connect(ctx.destination);
  const [gain] = [...music.out] as InstanceType<typeof a.GainNode>[];
  expect(gain).toBeInstanceOf(a.GainNode);
  expect([...sfx.out]).toEqual([gain!]);
  expect([...gain!.out]).toEqual([ctx.destination]);
  expect(gain!.gain.value).toBe(0.7);

  vol.set(0.2);
  expect(gain!.gain.value).toBe(0.2);

  // another context gets its own gain, at the current volume
  const other = new a.Ctx();
  const node = new a.AudioNode(other);
  node.connect(other.destination);
  const g2 = [...node.out][0] as InstanceType<typeof a.GainNode>;
  expect(g2).not.toBe(gain);
  expect(g2.gain.value).toBe(0.2);
});

test("connections elsewhere are untouched; disconnecting the destination undoes the gain's", () => {
  const a = fakeAudio();
  installVolume({ AudioNode: a.AudioNode, AudioDestinationNode: a.AudioDestinationNode } as never, 1);
  const ctx = new a.Ctx();
  const src = new a.AudioNode(ctx);
  const filter = new a.AudioNode(ctx);
  expect(src.connect(filter)).toBe(filter);
  expect([...src.out]).toEqual([filter]);
  filter.connect(ctx.destination);
  expect(filter.out.size).toBe(1);
  filter.disconnect(ctx.destination);
  expect(filter.out.size).toBe(0);
});

test("volume is clamped to 0–1", () => {
  const a = fakeAudio();
  const vol = installVolume({ AudioNode: a.AudioNode, AudioDestinationNode: a.AudioDestinationNode } as never, 5);
  const ctx = new a.Ctx();
  const n = new a.AudioNode(ctx);
  n.connect(ctx.destination);
  const g = [...n.out][0] as InstanceType<typeof a.GainNode>;
  expect(g.gain.value).toBe(1);
  vol.set(-1);
  expect(g.gain.value).toBe(0);
});
