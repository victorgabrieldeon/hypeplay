// watch.js (bundled at startup, server/index.ts): the online guest's side, in page/watch.html. Joins the room (?room=),
// answers the host's WebRTC offer, shows the host's game, and sends this person's pad and keyboard every frame over a
// data channel; the host's pad.js makes them player 2 (guestpad.ts). The setting up goes through ../room (ps2rooms.ts).
// Each step says where it is, and a join that stops (an error, or no picture after a while) says where and why
// (watchsteps.ts), with "Abrir no navegador" inside Discord. When WebRTC isn't there (inside Discord), or doesn't link
// in time (relayWhen), the game comes through the server instead (relayguest.ts); ?relay=1 goes that way at once.
// ?watch=1 only watches: the same game, no controller sent (the host gives a watcher no pad channel either).
import { encodePad, KEYS } from "./guestpad";
import { joinRelay } from "./relayguest";
import { relayStuck, relayWhen, stuckAt, turnState, whereAmI, type Step, type Turn } from "./watchsteps";

const $ = (id: string) => document.getElementById(id)!;
const room = new URLSearchParams(location.search).get("room") ?? "";
const me = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
const NO_LINK_MS = 15_000;
/** How long the server's way may take to show a picture. */
const RELAY_MS = 10_000;
const framed = window.parent !== window;
const forceRelay = new URLSearchParams(location.search).get("relay") === "1";
const watching = new URLSearchParams(location.search).get("watch") === "1";

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
/** Whether the server's TURN answered this browser, once its ways through are gathered (watchsteps.ts). */
let turn: Turn = "none";
/** The game through the server, once it went that way. */
let relaying: ReturnType<typeof joinRelay> | null = null;
/** While playing, "here" every few seconds: the library shows the room as taken. */
let beat = 0;
const here = () => {
  clearInterval(beat);
  beat = window.setInterval(() => void send("host", { type: "here", from: me }).catch(() => {}), 10_000);
};
const retry: Action = { label: "Tentar de novo", run: () => location.reload() };

/** The join stopped at `step`: say so, and offer a way on. */
function stuck(error?: string) {
  // (the server's way says for itself what stopped it)
  if (linked || relaying) return;
  const s = stuckAt(step, error, whereAmI(framed, location.hostname), turn);
  const actions: Action[] = [{ label: "Tentar de novo", run: () => location.reload() }];
  // (overlay.js asks, and shows the link to copy right away; without it, asked from here)
  const open = () => {
    if (dispatchEvent(new Event("hypeplay:open", { cancelable: true })))
      parent.postMessage({ t: "cordplay:open", path: location.pathname + location.search }, "*");
  };
  if (s.browser && framed) actions.unshift({ label: "Abrir no navegador", run: open });
  status(s.title, s.text, "error", actions);
}

/** By the server, from now on: the host hears so (`tell`) unless it said it first ("relay-only"). */
function goRelay(tell: boolean, pc: RTCPeerConnection | null) {
  if (relaying || linked) return;
  if (tell) void send("host", { type: "relay", from: me }).catch(() => {});
  pc?.close();
  step = "linking";
  status("Conectando…", "Conectando pelo servidor…");
  const video = $("video") as HTMLVideoElement;
  const canvas = $("relay") as HTMLCanvasElement;
  const url = new URL(`../room/${room}/relay?role=guest&me=${me}`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const stop = (why: "closed" | "no-decoder") => {
    const s = relayStuck(why);
    $("dot").classList.remove("on");
    clearInterval(beat);
    status(s.title, s.text, "error", [retry]);
  };
  relaying = joinRelay({
    url: url.href,
    canvas,
    // (a watcher's pad is neutral, and dropped on the way all the same: it only keeps the socket alive)
    pad: () => (watching ? encodePad(null, new Set()) : encodePad(firstPad() as never, keys)),
    onLinked: () => {
      linked = true;
      video.hidden = true;
      canvas.hidden = false;
      $("dot").classList.add("on");
      status("", "", "hide");
      here();
    },
    onStuck: stop,
    onSound: () => ($("sound").hidden = false),
  });
  setTimeout(() => {
    if (linked || !relaying) return;
    relaying.stop();
    stop("closed");
  }, RELAY_MS);
}

async function send(to: string, msg: object) {
  const r = await fetch(`../room/${room}/${to}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  if (r.status === 404) throw new Error("gone");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
  if (watching) {
    document.title = "Assistindo · HypePlay";
    $("role").textContent = "Assistindo";
  }
  if (!/^[A-Z2-9]{6}$/.test(room)) return status("Sala inválida", "Volte para a biblioteca e escolha a sala de novo.", "error");
  // (from the very start: a step that never ends is said too)
  setTimeout(() => stuck(), NO_LINK_MS);
  const webrtc = typeof RTCPeerConnection === "function" && !forceRelay;
  let pc: RTCPeerConnection | null = null;
  /** When the host's offer came: WebRTC has LINK_MS from then (relayWhen). */
  let offerAt: number | null = null;
  try {
    status("Conectando…", "Preparando a conexão.");
    const ice = await fetch("../ice").then((r) => r.json()).catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    const video = $("video") as HTMLVideoElement;
    if (webrtc) {
      const p = (pc = new RTCPeerConnection({ iceServers: ice }));
      // (picture and sound arrive as separate tracks: one stream for the video element holds both)
      const remote = new MediaStream();
      p.ontrack = (e) => {
        remote.addTrack(e.track);
        if (video.srcObject !== remote) video.srcObject = remote;
        void video.play().catch(() => {});
        if (e.track.kind === "audio") $("sound").hidden = false;
      };
      p.ondatachannel = (e) => {
        const channel = e.channel;
        const tick = () => {
          if (channel.readyState === "open") channel.send(JSON.stringify(encodePad(firstPad() as never, keys)));
          if (channel.readyState !== "closed") setTimeout(tick, 1000 / 60);
        };
        channel.onopen = tick;
      };
      p.onconnectionstatechange = () => {
        if (relaying) return;
        const connected = p.connectionState === "connected";
        $("dot").classList.toggle("on", connected);
        if (connected) {
          linked = true;
          status("", "", "hide");
          here();
        } else if (linked && (p.connectionState === "disconnected" || p.connectionState === "closed")) {
          clearInterval(beat);
          gone();
        }
      };
    }
    $("sound").addEventListener("click", () => {
      video.muted = false;
      void video.play().catch(() => {});
      void relaying?.unmute();
      $("sound").hidden = true;
    });
    addEventListener("pagehide", () => navigator.sendBeacon?.(`../room/${room}/host`, JSON.stringify({ type: "bye", from: me })));

    step = "joining";
    status("Conectando…", "Avisando o host.");
    await send("host", { type: "join", from: me, ...(watching ? { watch: true } : {}) });
    step = "waiting";
    status("Conectando…", "Esperando o host aceitar.");
    // by the server when WebRTC isn't here, failed, or didn't link in time
    const check = window.setInterval(() => {
      if (linked || relaying) return clearInterval(check);
      if (relayWhen({ webrtc, offerAt, now: performance.now(), state: pc?.connectionState ?? null }) === "now") goRelay(true, pc);
    }, 500);
    for (let after = 0; !linked; ) {
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
          if (watching) return status("A sala está cheia", "Já tem o máximo de pessoas assistindo. Tente de novo daqui a pouco.", "error", [retry]);
          const watch: Action = { label: "Assistir", run: () => (location.search += "&watch=1") };
          return status("A sala está cheia", "Já tem alguém jogando como jogador 2. Dá para assistir a partida enquanto isso.", "error", [watch, retry]);
        }
        // the host has no WebRTC (inside Discord): by the server from the start
        if (m.type === "relay-only") goRelay(false, pc);
        if (m.type === "relay-no") {
          linked = true; // (said here)
          relaying?.stop();
          const s = relayStuck("host-cant");
          return status(s.title, s.text, "error", [retry]);
        }
        if (m.type !== "offer" || !m.sdp || !pc || relaying || offerAt !== null) continue;
        offerAt = performance.now();
        step = "linking";
        status("Conectando…", "Ligando a imagem do jogo.");
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        turn = turnState(ice, pc.localDescription?.sdp ?? "");
        await send("host", { type: "answer", from: me, sdp: pc.localDescription!.sdp });
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
