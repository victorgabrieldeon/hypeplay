/**
 * The games' volume: whatever they play through WebAudio reaches the speakers through one GainNode per context, put
 * there by catching every connect() to a context's destination; <audio> and <video> get their volume set. Installed
 * before the game's own scripts run (overlay.js is in the page's <head>). The constructors come in as arguments so
 * tests can hand in fakes.
 */

interface Node {
  context: { destination: unknown; createGain(): Gain };
  connect(to: unknown, ...rest: unknown[]): unknown;
  disconnect(to?: unknown, ...rest: unknown[]): unknown;
}
interface Gain extends Node {
  gain: { value: number };
}
type Ctor<T> = { prototype: T };

export interface AudioApi {
  AudioNode: Ctor<Node>;
  AudioDestinationNode: Ctor<unknown>;
  HTMLMediaElement?: Ctor<{ volume: number; play(): unknown }>;
  document?: { querySelectorAll(selector: string): ArrayLike<{ volume: number }> };
}

const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));

export function installVolume(api: AudioApi, initial: number) {
  let volume = clamp(initial);
  const gains = new Map<unknown, Gain>();
  const proto = api.AudioNode.prototype;
  const connect = proto.connect;
  const disconnect = proto.disconnect;
  const isDestination = (n: unknown) => n instanceof (api.AudioDestinationNode as unknown as new () => unknown);

  function gainOf(node: Node): Gain {
    const ctx = node.context;
    let g = gains.get(ctx);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = volume;
      connect.call(g, ctx.destination);
      gains.set(ctx, g);
    }
    return g;
  }

  proto.connect = function (this: Node, to: unknown, ...rest: unknown[]) {
    // (the gain itself goes to the destination through the original connect, in gainOf)
    if (isDestination(to) && gains.get(this.context) !== this) return connect.call(this, gainOf(this), ...rest);
    return connect.call(this, to, ...rest);
  };
  proto.disconnect = function (this: Node, to?: unknown, ...rest: unknown[]) {
    if (isDestination(to) && gains.has(this.context) && gains.get(this.context) !== this) return disconnect.call(this, gains.get(this.context), ...rest);
    return disconnect.call(this, to, ...rest);
  };

  const media = () => (api.document ? Array.from(api.document.querySelectorAll("audio, video")) : []);
  if (api.HTMLMediaElement) {
    const play = api.HTMLMediaElement.prototype.play;
    api.HTMLMediaElement.prototype.play = function (this: { volume: number; play(): unknown }) {
      this.volume = volume;
      return play.call(this);
    };
  }

  return {
    get volume() {
      return volume;
    },
    set(v: number) {
      volume = clamp(v);
      for (const g of gains.values()) g.gain.value = volume;
      for (const m of media()) m.volume = volume;
    },
  };
}
