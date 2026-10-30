// The online host's side, in the PS2 game's page (ps2play.ts puts "Abrir sala" in its bar): opens a room (../room),
// and for the guest who joins sends the game's picture (the canvas) and sound (overlay.js's gain, volume.ts) over
// WebRTC; what the guest sends back on the "pad" channel becomes player 2 through pad.js (guestpad.ts).

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

/** One guest at a time: player 2. A second one waits until the first leaves. */
async function serve(code: string, button: HTMLButtonElement) {
  const ice = await fetch("../ice").then((r) => r.json()).catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  let guest: { id: string; pc: RTCPeerConnection } | null = null;
  const drop = () => {
    guest?.pc.close();
    guest = null;
    w.cordplayGuest?.leave();
    button.textContent = `Sala ${code} · esperando`;
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
      if (m.type === "join" && m.from && !guest) {
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
        channel.onclose = drop;
        pc.onconnectionstatechange = () => ["failed", "closed", "disconnected"].includes(pc.connectionState) && guest?.pc === pc && drop();
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        await post(code, m.from, { type: "offer", sdp: pc.localDescription!.sdp });
      } else if (m.type === "answer" && guest && m.from === guest.id && m.sdp) {
        await guest.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => drop());
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
    void serve(room, button);
  });
  return button;
}
