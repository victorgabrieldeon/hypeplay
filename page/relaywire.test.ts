import { expect, test } from "bun:test";
import { decode, encode, HELLO, HOST_BACKLOG, hostBehind, isKeyVideo, pickCodec, VIDEO, type Packet } from "./relaywire";

test("each packet goes and comes back as it was", () => {
  const data = Uint8Array.of(9, 8, 7);
  for (const p of [
    { t: "hello", video: ["vp8"], audio: ["opus"] },
    { t: "config", video: { codec: "vp8", width: 640, height: 480 }, audio: { codec: "opus", sampleRate: 48000, numberOfChannels: 2 } },
    { t: "video", key: true, time: 4_294_967_295, data },
    { t: "audio", time: 20, data },
    { t: "pad", pad: { b: [1, 0], a: [0.5] } },
    { t: "key" },
    { t: "bye" },
  ] as Packet[]) expect(decode(encode(p))).toEqual(p);
});

test("the first byte is the kind, the video's key flag the second's low bit", () => {
  expect(encode({ t: "video", key: true, time: 1, data: new Uint8Array() })[0]).toBe(VIDEO);
  expect(isKeyVideo(encode({ t: "video", key: true, time: 1, data: new Uint8Array() }))).toBe(true);
  expect(isKeyVideo(encode({ t: "video", key: false, time: 1, data: new Uint8Array() }))).toBe(false);
  expect(isKeyVideo(encode({ t: "key" }))).toBe(false);
});

test("what isn't a packet is null", () => {
  for (const b of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(99), Uint8Array.of(VIDEO, 1), Uint8Array.of(HELLO, 123)]) expect(decode(b)).toBeNull();
});

test("the codec: the first both can, H.264 before VP8, none in common is null", async () => {
  expect(await pickCodec(["vp8", "avc1.42E01F"], async () => true)).toBe("avc1.42E01F");
  expect(await pickCodec(["vp8", "avc1.42E01F"], async (c) => c === "vp8")).toBe("vp8");
  expect(await pickCodec(["av01.0.04M.08"], async () => true)).toBeNull();
});

test("the host waits when its upload falls behind: past 512 KB still to go out", () => {
  expect(HOST_BACKLOG).toBe(512 * 1024);
  expect(hostBehind(0)).toBe(false);
  expect(hostBehind(HOST_BACKLOG)).toBe(false);
  expect(hostBehind(HOST_BACKLOG + 1)).toBe(true);
});
