// watch.js (bundled at startup, server/index.ts): the online guest's side, in page/watch.html. Joins the room (?room=),
// answers the host's WebRTC offer, shows the host's game, and sends this person's pad and keyboard every frame over a
// data channel; the host's pad.js makes them player 2 (guestpad.ts). The setting up goes through ../room (ps2rooms.ts).
// Each step says where it is, and a join that stops (an error, or no picture after a while) says where and why
// (watchsteps.ts), with "Abrir no navegador" inside Discord.
import { encodePad, KEYS } from "./guestpad";
import { stuckAt, type Step } from "./watchsteps";

const $ = (id: string) => document.getElementById(id)!;
const room = new URLSearchParams(location.search).get("room") ?? "";
const me = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
const NO_LINK_MS = 15_000;
const framed = window.parent !== window;

type Action = { label: string; run: () => void };

function status(title: string, text: string, kind: "wait" | "error" | "hide" = "wait", actions: Action[] = []) {
  const s = $("status");
  s.hidden = kind === "hide";
  s.className = kind === "error" ? "error" : "";
  s.innerHTML = `${kind === "wait" ? '<div class="spin"></div>' : ""}<h1></h1><p></p>${actions.length ? '<div class="actions"></div>' : ""}`;
  s.querySelector("h1")!.textContent = title;
  s.querySelector("p")!.textContent = text;
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.addEventListener("click", a.run);
    s.querySelector(".actions")!.append(b);
  }
}

let step: Step = "start";
let linked = false;

/** The join stopped at `step`: say so, and offer a way on. */
function stuck(error?: string) {
  if (linked) return;
  const s = stuckAt(step, error);
  const actions: Action[] = [{ label: "Tentar de novo", run: () => location.reload() }];
  if (s.browser && framed)
    actions.unshift({ label: "Abrir no navegador", run: () => parent.postMessage({ t: "cordplay:open", path: location.pathname + location.search }, "*") });
  status(s.title, s.text, "error", actions);
}

async function send(to: string, msg: object) {
  const r = await fetch(`../room/${room}/${to}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  if (r.status === 404) throw new Error("gone");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

// (the entry page had nowhere to open it: the server has no PUBLIC_URL)
window.addEventListener("message", (e) => {
  if (e.source === parent && (e.data as { t?: unknown } | null)?.t === "cordplay:cant-open")
    status("Não deu para abrir no navegador", "Este servidor ainda não tem o endereço público (PUBLIC_URL). Quem cuida dele precisa configurar.", "error", [
      { label: "Tentar de novo", run: () => location.reload() },
    ]);
});

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
  // (from the very start: a step that never ends is said too)
  setTimeout(() => stuck(), NO_LINK_MS);
  try {
    status("Conectando…", "Preparando a conexão.");
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
    // while playing, "here" every few seconds: the library shows the room as taken
    let beat = 0;
    pc.onconnectionstatechange = () => {
      const connected = pc.connectionState === "connected";
      clearInterval(beat);
      if (connected) beat = window.setInterval(() => void send("host", { type: "here", from: me }).catch(() => {}), 10_000);
      $("dot").classList.toggle("on", connected);
      if (connected) {
        linked = true;
        status("", "", "hide");
      } else if (pc.connectionState === "failed") stuck();
      else if (linked && (pc.connectionState === "disconnected" || pc.connectionState === "closed")) gone();
    };
    addEventListener("pagehide", () => navigator.sendBeacon?.(`../room/${room}/host`, JSON.stringify({ type: "bye", from: me })));

    step = "joining";
    status("Conectando…", "Avisando o host.");
    await send("host", { type: "join", from: me });
    step = "waiting";
    status("Conectando…", "Esperando o host aceitar.");
    for (let after = 0; ; ) {
      // (a dropped request is retried: only the server saying the room is gone ends it)
      const r = await fetch(`../room/${room}/${me}?after=${after}`, { cache: "no-store" }).catch(() => null);
      if (r?.status === 404) return gone();
      if (!r?.ok) {
        await new Promise((ok) => setTimeout(ok, 2000));
        continue;
      }
      const { messages, next } = (await r.json()) as { messages: { type?: string; sdp?: string }[]; next: number };
      after = next;
      for (const m of messages) {
        if (m.type === "full") {
          linked = true; // (said here; nothing more to say later)
          return status("A sala está cheia", "Já tem alguém jogando como jogador 2. Tente de novo quando a vaga abrir.", "error");
        }
        if (m.type !== "offer" || !m.sdp) continue;
        step = "linking";
        status("Conectando…", "Ligando a imagem do jogo.");
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        await send("host", { type: "answer", from: me, sdp: pc.localDescription!.sdp });
        return;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === "gone") return gone();
    console.warn("HypePlay: player 2 stopped at", step, err);
    stuck(err instanceof Error ? err.message : String(err));
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
