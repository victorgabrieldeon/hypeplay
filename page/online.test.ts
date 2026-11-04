import { expect, test } from "bun:test";
import { linkLabel, linkStats, NO_RELAY, onlineIce, videoBitrate } from "./online";

test("the online goes direct or by a TURN, never by the server's relay: the ICE servers stay as ../ice gave them", () => {
  expect(NO_RELAY).toBe(true);
  const ice = [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "u", credential: "c" },
  ];
  expect(onlineIce(ice)).toEqual(ice);
  // (nothing came: a public STUN, so the direct way is still tried)
  expect(onlineIce([])).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  expect(onlineIce(null)).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
});

test("the picture's room grows with the host's size: 1x 4 Mbps, 2x 8, 3x 19, never past 20", () => {
  expect(videoBitrate(640, 448)).toBe(4_000_000);
  expect(videoBitrate(1280, 896)).toBe(8_000_000);
  expect(videoBitrate(1920, 1344)).toBe(19_000_000);
  expect(videoBitrate(2560, 1792)).toBe(20_000_000);
  expect(videoBitrate(0, 0)).toBe(4_000_000);
});

const report = (rows: Record<string, unknown>[]) => new Map(rows.map((r, i) => [typeof r.id === "string" ? r.id : `r${i}`, r]));

test("the link, from the connection's stats: ping, fps, size and which way it goes", () => {
  const stats = report([
    { id: "t", type: "transport", selectedCandidatePairId: "p" },
    { id: "p", type: "candidate-pair", localCandidateId: "l", currentRoundTripTime: 0.0234 },
    { id: "l", type: "local-candidate", candidateType: "srflx" },
    { id: "v", type: "inbound-rtp", kind: "video", framesPerSecond: 59.6, frameWidth: 640, frameHeight: 448 },
    { id: "a", type: "inbound-rtp", kind: "audio" },
  ]);
  expect(linkStats(stats)).toEqual({ ping: 23, fps: 60, width: 640, height: 448, via: "direto", frames: null, time: null });
  expect(linkLabel(linkStats(stats))).toBe("23 ms · 60 fps · 640×448 · direto");
});

test("fps from the frames decoded since the last look, when the browser doesn't say it", () => {
  const at = (frames: number, time: number) => report([{ id: "v", type: "inbound-rtp", kind: "video", framesDecoded: frames, timestamp: time }]);
  const first = linkStats(at(100, 1000));
  expect(first.fps).toBeNull();
  expect(linkStats(at(160, 2000), first).fps).toBe(60);
  expect(linkStats(at(190, 2500), linkStats(at(160, 2000))).fps).toBe(60);
  // (said by the browser: that, as it is)
  expect(linkStats(report([{ id: "v", type: "inbound-rtp", kind: "video", framesPerSecond: 30, framesDecoded: 5, timestamp: 9 }]), first).fps).toBe(30);
});

test("a relay candidate is the TURN; a host one, the same network; what's missing stays out", () => {
  const relay = report([
    { id: "p", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "l", currentRoundTripTime: 0.31 },
    { id: "l", type: "local-candidate", candidateType: "relay" },
  ]);
  expect(linkStats(relay)).toEqual({ ping: 310, fps: null, width: null, height: null, via: "TURN", frames: null, time: null });
  expect(linkLabel(linkStats(relay))).toBe("310 ms · TURN");
  const lan = report([
    { id: "p", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "l" },
    { id: "l", type: "local-candidate", candidateType: "host" },
  ]);
  expect(linkLabel(linkStats(lan))).toBe("rede local");
  expect(linkLabel(linkStats(report([])))).toBe("");
});
