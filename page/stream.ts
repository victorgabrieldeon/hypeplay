// The online host's side, in the PS2 game's page (ps2play.ts puts "Abrir sala" in its bar): opens a room (../room),
// and for the guest who joins sends the game's picture (the canvas) and sound (overlay.js's gain, volume.ts) over
// WebRTC; what the guest sends back on the "pad" channel becomes player 2 through pad.js (guestpad.ts). Others may join
// only to watch (join with watch: true): the same picture and sound, no controller. When WebRTC
// can't link them (player 2 asks: "relay"), or this side has none (then "relay-only"), the same goes through the
// server instead (relayhost.ts); a browser that can't encode says so ("relay-no").
// P2P only (online.ts): no TURN, no relay; a host without WebRTC tells the guest so ("relay-only", and the guest says
// the host has to open the game in the browser).
import { P2P_ONLY, p2pIce, videoBitrate } from "./online";
import { canRelay, startRelay } from "./relayhost";

interface Guest {
  join(): void;
  set(msg: unknown): void;
  leave(): void;
}
const w = window as unknown as { cordplayGuest?: Guest; cordplayVolume?: { tap(): MediaStream | null } };

type Msg = { type?: string; from?: string; sdp?: string; watch?: boolean; relay?: boolean };

async function post(code: string, to: string, msg: object) {
  await fetch(`../room/${code}/${to}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
}

function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((ok) => {
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && ok());
    setTimeout(ok, 3000);
  });
}

/**
 * The game's canvas as it is (its size, 1x or 2x, is what player 1 sees) at 60 fps: room to send it (videoBitrate),
 * and frames dropped before the size is.
 */
async function sharp(sender: RTCRtpSender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    const s = sender.track?.getSettings();
    const bitrate = videoBitrate(s?.width ?? 0, s?.height ?? 0);
    // (looked at again every few seconds, as player 1 may switch Nativa / 2×: only a change goes)
    if (p.encodings.every((e) => e.maxBitrate === bitrate)) return;
    for (const e of p.encodings) Object.assign(e, { maxBitrate: bitrate, maxFramerate: 60, scaleResolutionDownBy: 1 });
    (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "maintain-resolution";
    await sender.setParameters(p);
  } catch {
    // (a browser that won't: its own choices)
  }
}

/** Each watcher costs this page one more stream (an encode and some 2.5 Mbps up): a few at most. */
// shortcut: one encoder per guest (WebRTC or relay), switch the relay to a server fan-out if watchers grow or the
// graphics card runs out of encoder sessions (player 2 plus 4 watchers is 5).
const MAX_WATCHERS = 4;

type Visitor = { id: string; watch: boolean; linked: boolean; pc?: RTCPeerConnection; video?: MediaStreamTrack; relay?: { stop(): void }; sharp?: number };

/** One player 2 at a time (a second hears the room is full), and up to MAX_WATCHERS who only watch. */
async function serve(code: string, button: HTMLButtonElement) {
  const ice = p2pIce(await fetch("../ice").then((r) => r.json()).catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]));
  const guests = new Map<string, Visitor>();
  const player = () => [...guests.values()].find((g) => !g.watch);
  const label = () => {
    const p = player();
    const watching = [...guests.values()].filter((g) => g.watch && g.linked).length;
    const two = p?.linked ? `jogador 2 conectado${p.relay ? " pelo servidor" : ""}` : "esperando";
    button.textContent = `Sala ${code} · ${two}${watching ? ` · ${watching} assistindo` : ""}`;
  };
  const linked = (g: Visitor) => {
    g.linked = true;
    if (!g.watch) w.cordplayGuest?.join();
    label();
  };
  const drop = (id: string) => {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    g.pc?.close();
    // (its own canvas capture; the sound's tracks are everyone's, volume.ts' tap)
    g.video?.stop();
    clearInterval(g.sharp);
    g.relay?.stop();
    if (!g.watch) w.cordplayGuest?.leave();
    label();
  };
  /** A guest by the server: its WebRTC connection, if any, goes (its controller mustn't come twice). false: can't. */
  const relayTo = (id: string, watch: boolean): boolean => {
    const canvas = document.querySelector<HTMLCanvasElement>("#screen canvas, canvas");
    if (!canRelay() || !canvas) {
      void post(code, id, { type: "relay-no" });
      return false;
    }
    const old = guests.get(id);
    const url = new URL(`../room/${code}/relay?role=host&me=${id}`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const g: Visitor = { id, watch, linked: false };
    const relay = (g.relay = startRelay({
      url: url.href,
      canvas,
      audio: w.cordplayVolume?.tap() ?? null,
      // (a watcher's controller is dropped on the way, server/relay.ts; and here)
      onPad: (pad) => !watch && w.cordplayGuest?.set(pad),
      onJoin: () => linked(g),
      onLeave: () => guests.get(id)?.relay === relay && drop(id),
      onNoCodec: () => void post(code, id, { type: "relay-no" }),
    }));
    guests.set(id, g);
    old?.pc?.close();
    old?.video?.stop();
    return true;
  };
  for (let after = 0; ; ) {
    const r = await fetch(`../room/${code}/host?after=${after}`, { cache: "no-store" }).catch(() => null);
    if (r?.status === 404) {
      for (const id of [...guests.keys()]) drop(id);
      button.textContent = "Abrir sala";
      button.disabled = false;
      return;
    }
    if (!r?.ok) {
      await new Promise((ok) => setTimeout(ok, 2000));
      continue;
    }
    const { messages, next } = (await r.json()) as { messages: Msg[]; next: number };
    after = next;
    for (const m of messages) {
      const from = m.from;
      if (!from) continue;
      const known = guests.get(from);
      if (m.type === "join" && !known) {
        const watch = m.watch === true;
        const full = watch ? [...guests.values()].filter((g) => g.watch).length >= MAX_WATCHERS : !!player();
        if (full) {
          await post(code, from, { type: "full", watch });
        } else if (typeof RTCPeerConnection !== "function" || m.relay === true) {
          // (no WebRTC here or there, inside Discord say: by the server from the start, no offer to wait on)
          if (P2P_ONLY) await post(code, from, { type: "relay-only" });
          else if (relayTo(from, watch)) await post(code, from, { type: "relay-only" });
        } else {
          const pc = new RTCPeerConnection({ iceServers: ice });
          const g: Visitor = { id: from, watch, linked: false, pc };
          guests.set(from, g);
          // picture (the game's canvas) and sound (the game's gain) in one stream
          const out = new MediaStream();
          const canvas = document.querySelector<HTMLCanvasElement>("#screen canvas, canvas");
          const video = canvas?.captureStream(60).getVideoTracks()[0];
          if (video) {
            video.contentHint = "motion";
            out.addTrack(video);
            g.video = video;
          }
          for (const t of w.cordplayVolume?.tap()?.getAudioTracks() ?? []) out.addTrack(t);
          for (const t of out.getTracks()) pc.addTrack(t, out);
          if (watch) {
            // (a watcher sends nothing back: linked once the connection is)
            pc.addEventListener("connectionstatechange", () => pc.connectionState === "connected" && !g.linked && linked(g));
          } else {
            const channel = pc.createDataChannel("pad", { ordered: false, maxRetransmits: 0 });
            channel.onopen = () => linked(g);
            channel.onmessage = (e) => {
              try {
                w.cordplayGuest?.set(JSON.parse(String(e.data)));
              } catch {
                // (a broken message is dropped)
              }
            };
            // (only this connection's end drops its guest; "disconnected" is often a moment, "failed" is not)
            channel.onclose = () => guests.get(from)?.pc === pc && drop(from);
          }
          pc.addEventListener("connectionstatechange", () => ["failed", "closed"].includes(pc.connectionState) && guests.get(from)?.pc === pc && drop(from));
          await pc.setLocalDescription(await pc.createOffer());
          // (once negotiating: before, a browser may refuse new encodings)
          const resharp = () => {
            for (const sender of pc.getSenders()) if (sender.track?.kind === "video") void sharp(sender);
          };
          resharp();
          g.sharp = window.setInterval(resharp, 2000);
          await gathered(pc);
          await post(code, from, { type: "offer", sdp: pc.localDescription!.sdp });
        }
      } else if (m.type === "relay" && known && !known.relay && !P2P_ONLY) {
        relayTo(from, known.watch);
      } else if (m.type === "answer" && known?.pc && m.sdp) {
        await known.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => drop(from));
      } else if (m.type === "bye" && known) {
        drop(from);
      }
    }
  }
}

/** "Abrir sala" for the bar. */
export function roomButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Abrir sala";
  button.title = "Abre uma sala: um amigo entra pela biblioteca como jogador 2, e outros podem assistir";
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    const r = await fetch("../room", { method: "POST" }).catch(() => null);
    if (!r?.ok) {
      button.disabled = false;
      button.textContent = "Não deu para abrir a sala";
      return;
    }
    const { room } = (await r.json()) as { room: string };
    button.textContent = `Sala ${room} · esperando`;
    // leaving the game closes the room, so the library stops offering it
    addEventListener("pagehide", () => void fetch(`../room/${room}`, { method: "DELETE", keepalive: true }).catch(() => {}));
    void serve(room, button);
  });
  return button;
}
