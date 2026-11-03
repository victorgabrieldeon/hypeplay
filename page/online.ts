// How the PS2 games' online links host and guest (stream.ts, watch.ts). P2P only: the server's TURN is in Canada
// (~160 ms from Brazil each way, over 300 ms between two players), and so is its relay; a direct link between two homes
// is some 20-50 ms. So the TURN servers ../ice offers are left out, and the relay isn't used: a link that doesn't come
// says so (watchsteps.ts). P2P_ONLY = false brings both back.
// And the link's numbers for the guest's bar: ping, fps, picture size and which way it goes, from getStats().

export const P2P_ONLY = true;

/**
 * Up to this for the picture, for the host's canvas as it is (1x, 2x...: the guest sees what player 1 sees): some 0.12
 * bit a pixel at 60 fps, in whole Mbps, from 4 to 20. Room, so the browser keeps the size rather than shrink it.
 */
export function videoBitrate(width: number, height: number): number {
  const mbps = Math.round((width * height * 60 * 0.12) / 1e6);
  return Math.min(20, Math.max(4, mbps)) * 1_000_000;
}

type Ice = { urls: string | string[]; username?: string; credential?: string };

/** The ICE servers to use: P2P only, the STUN ones (a TURN's urls left out); none left, a public STUN. */
export function p2pIce(ice: Ice[]): Ice[] {
  if (!P2P_ONLY) return ice;
  const stun = ice.filter((s) => [s.urls].flat().every((u) => /^stuns?:/.test(u)));
  return stun.length ? stun : [{ urls: ["stun:stun.cloudflare.com:3478"] }];
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
