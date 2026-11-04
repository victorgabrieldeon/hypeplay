// How the PS2 games' online links host and guest (stream.ts, watch.ts): direct between the two homes (some 20-50 ms)
// when their routers allow it, else by the TURN ../ice gives (Cloudflare's, anycast, near the players: 40-80 ms). Never
// by the server's relay: it's in Canada (~300 ms between two players in Brazil), and so is the coturn there, which
// ../ice only gives when Cloudflare's doesn't answer. A link that doesn't come says so (watchsteps.ts).
// NO_RELAY = false brings the server's relay back.
// And the link's numbers for the guest's bar: ping, fps, picture size and which way it goes, from getStats().

export const NO_RELAY = true;

/**
 * Up to this for the picture, for the host's canvas as it is (1x, 2x...: the guest sees what player 1 sees): some 0.12
 * bit a pixel at 60 fps, in whole Mbps, from 4 to 20. Room, so the browser keeps the size rather than shrink it.
 */
export function videoBitrate(width: number, height: number): number {
  const mbps = Math.round((width * height * 60 * 0.12) / 1e6);
  return Math.min(20, Math.max(4, mbps)) * 1_000_000;
}

type Ice = { urls: string | string[]; username?: string; credential?: string };

/** The ICE servers to use, as ../ice gave them (its STUN and one TURN); none came, a public STUN. */
export function onlineIce(ice: Ice[] | null | undefined): Ice[] {
  return Array.isArray(ice) && ice.length ? ice : [{ urls: ["stun:stun.cloudflare.com:3478"] }];
}

export type Link = {
  ping: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  via: "direto" | "TURN" | "rede local" | null;
  /** the video's frames decoded so far, and when (ms): the fps of the next look, when the browser doesn't say it */
  frames: number | null;
  time: number | null;
};

type Row = Record<string, unknown> & { type?: string };

/**
 * From an RTCStatsReport (or any map of its rows): the chosen pair's ping and this side's candidate, the video's fps and
 * size. `prev`, the last look: the fps from the frames decoded since, when the browser doesn't give framesPerSecond.
 */
export function linkStats(report: { forEach(f: (row: Row) => void): void; get(id: string): unknown }, prev?: Link): Link {
  let pair: Row | undefined;
  let video: Row | undefined;
  report.forEach((r) => {
    if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pair = report.get(r.selectedCandidatePairId) as Row;
    if (!pair && r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
    if (r.type === "inbound-rtp" && r.kind === "video") video = r;
  });
  const local = pair && typeof pair.localCandidateId === "string" ? (report.get(pair.localCandidateId) as Row | undefined) : undefined;
  const kind = local?.candidateType;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rtt = num(pair?.currentRoundTripTime);
  const frames = num(video?.framesDecoded);
  const time = num(video?.timestamp);
  const said = num(video?.framesPerSecond);
  const since = prev?.frames != null && prev.time != null && frames !== null && time !== null && time > prev.time ? ((frames - prev.frames) * 1000) / (time - prev.time) : null;
  return {
    ping: rtt === null ? null : Math.round(rtt * 1000),
    fps: said !== null ? Math.round(said) : since === null ? null : Math.round(since),
    width: num(video?.frameWidth),
    height: num(video?.frameHeight),
    via: kind === "relay" ? "TURN" : kind === "host" ? "rede local" : kind === "srflx" || kind === "prflx" ? "direto" : null,
    frames,
    time,
  };
}

/** "23 ms · 60 fps · 640×448 · direto", what's known of it. */
export function linkLabel(l: Link): string {
  return [
    l.ping === null ? null : `${l.ping} ms`,
    l.fps === null ? null : `${l.fps} fps`,
    l.width && l.height ? `${l.width}×${l.height}` : null,
    l.via,
  ]
    .filter(Boolean)
    .join(" · ");
}
