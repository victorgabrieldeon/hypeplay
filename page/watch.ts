// watch.js (bundled at startup, server/index.ts): the online guest's side, in page/watch.html. Joins the room (?room=),
// answers the host's WebRTC offer, shows the host's game, and sends this person's pad and keyboard every frame over a
// data channel; the host's pad.js makes them player 2 (guestpad.ts). The setting up goes through ../room (ps2rooms.ts).
import { encodePad, KEYS } from "./guestpad";

const $ = (id: string) => document.getElementById(id)!;
const room = new URLSearchParams(location.search).get("room") ?? "";
const me = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
const NO_LINK_MS = 15_000;

function status(title: string, text: string, kind: "wait" | "error" | "hide" = "wait") {
  const s = $("status");
  s.hidden = kind === "hide";
  s.className = kind === "error" ? "error" : "";
  s.innerHTML = `${kind === "wait" ? '<div class="spin"></div>' : ""}<h1></h1><p></p>`;
  s.querySelector("h1")!.textContent = title;
  s.querySelector("p")!.textContent = text;
}

async function send(to: string, msg: object) {
  const r = await fetch(`../room/${room}/${to}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  if (r.status === 404) throw new Error("gone");
}

function gone() {
  status("A sala acabou", "O host saiu ou fechou a sala. Voltando para a biblioteca…", "error");
  setTimeout(() => (location.href = "../../../"), 4000);
}

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  if (e.code in KEYS) {
    keys.add(e.code);
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

function firstPad() {
  try {
    return [...navigator.getGamepads()].find((p) => p?.connected) ?? null;
  } catch {
    return null;
  }
}

async function start() {
  if (!/^[A-Z2-9]{6}$/.test(room)) return status("Sala inválida", "Volte para a biblioteca e escolha a sala de novo.", "error");
  const ice = await fetch("../ice").then((r) => r.json()).catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  const pc = new RTCPeerConnection({ iceServers: ice });
  const video = $("video") as HTMLVideoElement;
  // (picture and sound arrive as separate tracks: one stream for the video element holds both)
  const remote = new MediaStream();
  pc.ontrack = (e) => {
    remote.addTrack(e.track);
    if (video.srcObject !== remote) video.srcObject = remote;
    void video.play().catch(() => {});
    if (e.track.kind === "audio") $("sound").hidden = false;
  };
  $("sound").addEventListener("click", () => {
    video.muted = false;
    void video.play();
    $("sound").hidden = true;
  });
  pc.ondatachannel = (e) => {
    const channel = e.channel;
    const tick = () => {
      if (channel.readyState === "open") channel.send(JSON.stringify(encodePad(firstPad() as never, keys)));
      if (channel.readyState !== "closed") setTimeout(tick, 1000 / 60);
    };
    channel.onopen = tick;
  };
  pc.onconnectionstatechange = () => {
    const connected = pc.connectionState === "connected";
    $("dot").classList.toggle("on", connected);
    if (connected) status("", "", "hide");
    else if (pc.connectionState === "failed") status("Sem conexão com o host", "As redes de vocês não se alcançaram. O servidor precisa de um TURN.", "error");
    else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") gone();
  };
  setTimeout(() => {
    if (pc.connectionState !== "connected") status("Sem conexão com o host", "Não deu para conectar. Talvez a rede de um dos dois bloqueie; o servidor precisa de um TURN.", "error");
  }, NO_LINK_MS);
  addEventListener("pagehide", () => navigator.sendBeacon?.(`../room/${room}/host`, JSON.stringify({ type: "bye", from: me })));

  try {
    await send("host", { type: "join", from: me });
    status("Conectando…", "Esperando o host aceitar.");
    for (let after = 0; ; ) {
      const r = await fetch(`../room/${room}/${me}?after=${after}`, { cache: "no-store" });
      if (r.status === 404) return gone();
      if (!r.ok) {
        await new Promise((ok) => setTimeout(ok, 2000));
        continue;
      }
      const { messages, next } = (await r.json()) as { messages: { type?: string; sdp?: string }[]; next: number };
      after = next;
      for (const m of messages) {
        if (m.type !== "offer" || !m.sdp) continue;
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        await send("host", { type: "answer", from: me, sdp: pc.localDescription!.sdp });
        return;
      }
    }
  } catch {
    gone();
  }
}

/** Every candidate in the description (no trickle: the room carries whole messages). */
function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((ok) => {
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && ok());
    setTimeout(ok, 3000);
  });
}

void start();
