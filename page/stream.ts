// The online host's side, in the PS2 game's page (ps2play.ts puts "Abrir sala" in its bar): opens a room (../room),
// and for the guest who joins sends the game's picture (the canvas) and sound (overlay.js's gain, volume.ts) over
// WebRTC; what the guest sends back on the "pad" channel becomes player 2 through pad.js (guestpad.ts). When WebRTC
// can't link them (player 2 asks: "relay"), or this side has none (then "relay-only"), the same goes through the
// server instead (relayhost.ts); a browser that can't encode says so ("relay-no").
import { canRelay, startRelay } from "./relayhost";

interface Guest {
  join(): void;
  set(msg: unknown): void;
  leave(): void;
}
const w = window as unknown as { cordplayGuest?: Guest; cordplayVolume?: { tap(): MediaStream | null } };

type Msg = { type?: string; from?: string; sdp?: string };

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

/** One guest at a time: player 2. A second one hears the room is full. */
async function serve(code: string, button: HTMLButtonElement) {
  const ice = await fetch("../ice").then((r) => r.json()).catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  let guest: { id: string; pc?: RTCPeerConnection; relay?: { stop(): void } } | null = null;
  const drop = () => {
    guest?.pc?.close();
    guest?.relay?.stop();
    guest = null;
    w.cordplayGuest?.leave();
    button.textContent = `Sala ${code} · esperando`;
  };
  /** Player 2 by the server: its WebRTC connection, if any, goes (its controller mustn't come twice). */
  const relayTo = (id: string) => {
    const old = guest?.pc;
    if (!canRelay()) {
      void post(code, id, { type: "relay-no" });
      return;
    }
    const url = new URL(`../room/${code}/relay?role=host`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const canvas = document.querySelector<HTMLCanvasElement>("#screen canvas, canvas");
    if (!canvas) return void post(code, id, { type: "relay-no" });
    const relay = startRelay({
      url: url.href,
      canvas,
      audio: w.cordplayVolume?.tap() ?? null,
      onPad: (pad) => w.cordplayGuest?.set(pad),
      onJoin: () => {
        w.cordplayGuest?.join();
        button.textContent = `Sala ${code} · jogador 2 conectado pelo servidor`;
      },
      onLeave: () => guest?.relay === relay && drop(),
      onNoCodec: () => void post(code, id, { type: "relay-no" }),
    });
    guest = { id, relay };
    old?.close();
  };
  for (let after = 0; ; ) {
    const r = await fetch(`../room/${code}/host?after=${after}`, { cache: "no-store" }).catch(() => null);
    if (r?.status === 404) {
      drop();
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
      if (m.type === "join" && m.from && guest && m.from !== guest.id) {
        // one player 2 at a time: a second guest hears the room is full
        await post(code, m.from, { type: "full" });
      } else if (m.type === "join" && m.from && !guest && typeof RTCPeerConnection !== "function") {
        // (no WebRTC here, inside Discord say: by the server from the start)
        relayTo(m.from);
        if (guest) await post(code, m.from, { type: "relay-only" });
      } else if (m.type === "relay" && m.from && (!guest || m.from === guest.id)) {
        if (!guest?.relay) relayTo(m.from);
      } else if (m.type === "join" && m.from && !guest) {
        const pc = new RTCPeerConnection({ iceServers: ice });
        guest = { id: m.from, pc };
        // picture (the game's canvas) and sound (the game's gain) in one stream
        const out = new MediaStream();
        const canvas = document.querySelector<HTMLCanvasElement>("#screen canvas, canvas");
        const video = canvas?.captureStream(60).getVideoTracks()[0];
        if (video) {
          video.contentHint = "motion";
          out.addTrack(video);
        }
        for (const t of w.cordplayVolume?.tap()?.getAudioTracks() ?? []) out.addTrack(t);
        for (const t of out.getTracks()) pc.addTrack(t, out);
        const channel = pc.createDataChannel("pad", { ordered: false, maxRetransmits: 0 });
        channel.onopen = () => {
          w.cordplayGuest?.join();
          button.textContent = `Sala ${code} · jogador 2 conectado`;
        };
        channel.onmessage = (e) => {
          try {
            w.cordplayGuest?.set(JSON.parse(String(e.data)));
          } catch {
            // (a broken message is dropped)
          }
        };
        // (only this connection's end drops its guest; "disconnected" is often a moment, "failed" is not)
        channel.onclose = () => guest?.pc === pc && drop();
        pc.onconnectionstatechange = () => ["failed", "closed"].includes(pc.connectionState) && guest?.pc === pc && drop();
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        await post(code, m.from, { type: "offer", sdp: pc.localDescription!.sdp });
      } else if (m.type === "answer" && guest && m.from === guest.id && m.sdp) {
        await guest.pc?.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => drop());
      } else if (m.type === "bye" && guest && m.from === guest.id) {
        drop();
      }
    }
  }
}

/** "Abrir sala" for the bar. */
export function roomButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Abrir sala";
  button.title = "Abre uma sala: um amigo entra pela biblioteca como jogador 2";
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
