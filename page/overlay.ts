// overlay.js (bundled at startup, server/index.ts; slipped into every game's page after pad.js): a small button in the
// top right corner (shown while the pointer moves, gone after a few still seconds, like a video player's controls)
// opens a panel with the way back to the library, the game's volume, a screen filter for old games, and how to play
// it online. The volume and filter are kept on the server per person (prefs, next to this script).
import { rendererName, slowRenderer } from "./gpu";
import { installVolume } from "./volume";

type Filter = "off" | "crt" | "scan";
interface Prefs {
  volume: number;
  filter: Filter;
}

/** What a game's page adds to the panel: its online (ps2play.ts: the room it opens), and a section of its own. */
export interface OverlayApi {
  online(hint: string, control?: HTMLElement): void;
  section(el: HTMLElement): void;
}

const here = (document.currentScript as HTMLScriptElement | null)?.src ?? location.href;
const prefsUrl = new URL("prefs", here);
/** The library: overlay.js sits at its root. */
const home = new URL(".", here);
const prefs: Prefs = { volume: 0.7, filter: "off" };
// Before the game's scripts run: everything they play goes through our gain from the start.
const volume = installVolume(
  { AudioNode, AudioDestinationNode, HTMLMediaElement, document } as unknown as Parameters<typeof installVolume>[0],
  prefs.volume,
);

// (the online host's stream.ts takes the game's sound from here)
(window as unknown as { cordplayVolume: typeof volume }).cordplayVolume = volume;

const FILTERS: [Filter, string][] = [["off", "Desligado"], ["crt", "TV de tubo"], ["scan", "Scanlines leves"]];

const CSS = `
#cp-ov { position: fixed; top: 10px; right: 10px; z-index: 2147483646; font: 500 13px/20px Manrope, ui-sans-serif, system-ui, sans-serif; color: #f3f2fb; }
#cp-ov button { font: inherit; color: inherit; }
#cp-ov .cp-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 10px; cursor: pointer;
  background: rgb(15 13 26 / 0.72); backdrop-filter: blur(8px); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
  opacity: 0; transition: opacity 220ms cubic-bezier(0.2, 0.8, 0.2, 1), background 120ms; }
html.cp-awake #cp-ov .cp-btn, #cp-ov:hover .cp-btn, #cp-ov .cp-btn:focus-visible, #cp-ov.open .cp-btn { opacity: 1; }
#cp-ov .cp-home { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 9px; background: #242040;
  color: #f3f2fb; text-decoration: none; font-weight: 700; transition: background 120ms; }
#cp-ov .cp-home:hover { background: #2c2750; }
#cp-ov .cp-home:focus-visible, #cp-ov .cp-online button:focus-visible { outline: 2px solid #a08cff; outline-offset: 2px; }
#cp-ov .cp-online { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid rgb(255 255 255 / 0.08); }
#cp-ov .cp-online[hidden] { display: none; }
#cp-ov .cp-hint { margin: 0; color: #a3a1bd; font-size: 12px; line-height: 18px; }
#cp-ov .cp-hint b { color: #f3f2fb; }
#cp-ov .cp-online button { height: 36px; border: 0; border-radius: 9px; background: #7655ff; color: #fff; font-weight: 700; cursor: pointer;
  box-shadow: 0 8px 20px -8px rgb(118 85 255 / 0.6); }
#cp-ov .cp-online button:disabled { background: #242040; box-shadow: none; cursor: default; }
.cp-code { font: 700 13px/18px ui-monospace, monospace; letter-spacing: 0.14em; color: #c9bdff; padding: 1px 6px; border-radius: 6px; background: #242040; }
#cp-gpu { top: auto !important; bottom: 16px; align-items: center; }
#cp-top .cp-copy { display: flex; gap: 6px; margin-top: 8px; }
#cp-top .cp-copy input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid rgb(255 255 255 / 0.12); border-radius: 8px; background: #1b1830; color: #f3f2fb; font: 500 12px/32px ui-monospace, monospace; }
#cp-top .cp-copy button { width: auto; height: 32px; padding: 0 12px; border-radius: 8px; background: #7655ff; color: #fff; font-weight: 700; }
#cp-top .cp-link { display: inline-block; margin-top: 8px; color: #a48cff; font-weight: 700; }
#cp-top .cp-mine { display: block; margin-top: 6px; color: #a3a1bd; font-size: 11px; }
#cp-top .cp-warn { display: block; margin-top: 8px; color: #f5a524; font-size: 12px; line-height: 18px; }
#cp-gpu .cp-browser { flex: none; height: 32px; padding: 0 12px; border: 0; border-radius: 8px; background: #7655ff; color: #fff; font: 700 13px/32px Manrope, ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
#cp-top, #cp-gpu { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; display: flex; align-items: flex-start; gap: 10px;
  width: max-content; max-width: min(520px, calc(100% - 120px)); padding: 12px 10px 12px 16px; border-radius: 14px; background: rgb(15 13 26 / 0.94);
  backdrop-filter: blur(10px); box-shadow: 0 18px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(160 140 255 / 0.3);
  font: 500 13px/20px Manrope, ui-sans-serif, system-ui, sans-serif; color: #d9d8ea; animation: cp-rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
#cp-top p, #cp-gpu p { margin: 0; }
#cp-top b, #cp-gpu b { color: #f3f2fb; }
#cp-top button, #cp-gpu .x { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: #a3a1bd; cursor: pointer; }
#cp-top button:hover, #cp-gpu .x:hover { color: #f3f2fb; background: #242040; }
#cp-top svg, #cp-gpu svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
#cp-ov .cp-btn:focus-visible, #cp-ov input:focus-visible, #cp-ov .cp-seg button:focus-visible { outline: 2px solid #a08cff; outline-offset: 2px; }
#cp-ov svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#cp-ov .cp-panel { position: absolute; top: 44px; right: 0; width: 288px; padding: 14px; border-radius: 14px; background: rgb(15 13 26 / 0.94);
  backdrop-filter: blur(10px); box-shadow: 0 18px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.08);
  display: none; flex-direction: column; gap: 12px; }
#cp-ov .cp-panel { max-height: calc(100vh - 64px); overflow-y: auto; scrollbar-width: thin; scrollbar-color: #2c2750 transparent; }
#cp-ov .cp-extra:empty { display: none; }
#cp-ov .cp-perf { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid rgb(255 255 255 / 0.08); }
#cp-ov .cp-group { display: flex; flex-direction: column; gap: 6px; }
#cp-ov .cp-sub { color: #d9d8ea; font-weight: 700; font-size: 12px; }
#cp-ov .cp-speed { text-transform: none; letter-spacing: 0; color: #3ddc84; font-variant-numeric: tabular-nums; }
#cp-ov .cp-speed.slow { color: #f5a524; }
#cp-ov .cp-slow { color: #f5a524; }
#cp-ov .cp-seg button:disabled { opacity: 0.45; cursor: default; }
#cp-ov .cp-reopen button { margin-left: 4px; padding: 2px 8px; border: 0; border-radius: 6px; background: #7655ff; color: #fff; font-weight: 700; cursor: pointer; }
#cp-ov.open .cp-panel { display: flex; animation: cp-rise 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes cp-rise { from { opacity: 0; transform: translateY(-6px); } }
#cp-ov .cp-label { display: flex; justify-content: space-between; color: #a3a1bd; font-weight: 600; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
#cp-ov .cp-vol { display: flex; align-items: center; gap: 8px; }
#cp-ov .cp-mute { width: 30px; height: 30px; border: 0; border-radius: 8px; background: #242040; display: grid; place-items: center; cursor: pointer; flex: none; }
#cp-ov input[type=range] { flex: 1; accent-color: #7655ff; height: 4px; cursor: pointer; }
#cp-ov .cp-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 3px; border-radius: 10px; background: #1b1830; }
#cp-ov .cp-seg button { border: 0; border-radius: 7px; padding: 6px 4px; background: none; color: #a3a1bd; cursor: pointer; font-size: 12px; font-weight: 600; }
#cp-ov .cp-seg button[aria-pressed=true] { background: #7655ff; color: #fff; }
/* (only still layers over the game, drawn once on their own layer: a CSS filter on the game's canvas, or an animation
   over it, costs every frame, and inside Discord that stutters) */
#cp-crt { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; display: none; transform: translateZ(0); }
html[data-cp-filter=crt] #cp-crt, html[data-cp-filter=scan] #cp-crt { display: block; }
html[data-cp-filter=crt] #cp-crt {
  background:
    radial-gradient(ellipse at center, transparent 55%, rgb(0 0 0 / 0.6) 100%),
    repeating-linear-gradient(to bottom, rgb(0 0 0 / 0.32) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgb(255 40 40 / 0.07) 0 1px, rgb(40 255 80 / 0.06) 1px 2px, rgb(60 90 255 / 0.07) 2px 3px);
  box-shadow: inset 0 0 140px rgb(0 0 0 / 0.65); }
html[data-cp-filter=scan] #cp-crt { background: repeating-linear-gradient(to bottom, rgb(0 0 0 / 0.16) 0 1px, transparent 1px 3px); }
#cp-ov .cp-browser { height: 36px; border: 0; border-radius: 9px; background: #242040; color: #f3f2fb; font-weight: 700; cursor: pointer; }
#cp-ov .cp-browser:hover { background: #2c2750; }
#cp-ov .cp-browser:disabled { color: #a3a1bd; cursor: default; }
@media (prefers-reduced-motion: reduce) { #cp-ov .cp-panel { animation: none !important; } }
`;

const ICON_ON = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_BACK ='<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
const ICON_TUNE ='<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    fetch(prefsUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(prefs) }).catch(() => {});
  }, 500);
}

/** Muting keeps the last volume, to come back to. */
let beforeMute = 0.7;

function apply() {
  volume.set(prefs.volume);
  document.documentElement.dataset.cpFilter = prefs.filter;
  const ov = document.getElementById("cp-ov");
  if (!ov) return;
  const range = ov.querySelector<HTMLInputElement>("input[type=range]")!;
  range.value = String(Math.round(prefs.volume * 100));
  range.setAttribute("aria-valuetext", `${range.value}%`);
  ov.querySelector(".cp-pct")!.textContent = `${range.value}%`;
  ov.querySelector(".cp-mute")!.innerHTML = prefs.volume === 0 ? ICON_OFF : ICON_ON;
  ov.querySelector(".cp-mute")!.setAttribute("aria-label", prefs.volume === 0 ? "Ligar o som" : "Tirar o som");
  for (const b of ov.querySelectorAll<HTMLButtonElement>("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === prefs.filter));
}

/** Back to the game: its keys and focus are its own. */
const backToGame = () => (document.querySelector("canvas") as HTMLElement | null)?.focus?.({ preventScroll: true });

function build() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const crt = document.createElement("div");
  crt.id = "cp-crt";
  const ov = document.createElement("div");
  ov.id = "cp-ov";
  ov.innerHTML = `<button class="cp-btn" type="button" aria-expanded="false" aria-controls="cp-panel" aria-label="Som e imagem">${ICON_TUNE}</button>
    <div class="cp-panel" id="cp-panel" role="dialog" aria-label="Som e imagem">
      <a class="cp-home" href="${home.href}">${ICON_BACK}Voltar para a biblioteca</a>
      <div class="cp-label"><span>Volume</span><span class="cp-pct"></span></div>
      <div class="cp-vol"><button class="cp-mute" type="button"></button><input type="range" min="0" max="100" step="1" aria-label="Volume do jogo"></div>
      <div class="cp-label"><span>Filtro de imagem</span></div>
      <div class="cp-seg" role="group" aria-label="Filtro de imagem">${FILTERS.map(([f, name]) => `<button type="button" data-filter="${f}">${name}</button>`).join("")}</div>
      <div class="cp-extra"></div>
      <div class="cp-online" hidden><div class="cp-label"><span>Jogar online</span></div><p class="cp-hint"></p></div>
      ${framed ? '<button class="cp-browser" type="button">Jogar no navegador (mais liso)</button>' : ""}
    </div>`;
  document.body.append(crt, ov);
  const btn = ov.querySelector<HTMLButtonElement>(".cp-btn")!;
  const toggle = (open: boolean) => {
    ov.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (!open) backToGame();
  };
  btn.addEventListener("click", () => toggle(!ov.classList.contains("open")));
  ov.querySelector("input")!.addEventListener("input", (e) => {
    prefs.volume = Number((e.target as HTMLInputElement).value) / 100;
    apply();
    save();
  });
  ov.querySelector(".cp-mute")!.addEventListener("click", () => {
    if (prefs.volume > 0) [beforeMute, prefs.volume] = [prefs.volume, 0];
    else prefs.volume = beforeMute || 0.7;
    apply();
    save();
  });
  ov.querySelector(".cp-seg")!.addEventListener("click", (e) => {
    const f = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]")?.dataset.filter as Filter | undefined;
    if (!f) return;
    prefs.filter = f;
    apply();
    save();
  });
  // Keys pressed in the panel are the panel's, not the game's; Esc closes it.
  ov.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") toggle(false);
  });
  for (const t of ["keyup", "keypress"]) ov.addEventListener(t, (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => { if (!ov.contains(e.target as Node)) toggle(false); }, true);
  ov.querySelector(".cp-browser")?.addEventListener("click", openInBrowser);
  apply();
  ov.querySelector(".cp-extra")!.append(...sections);
  if (pending) showOnline(...pending);
  else if (document.querySelector('meta[name="hypeplay-online"]')?.getAttribute("content") === "menu") portOnline();
  gpuCheck();
}

/** Inside Discord (the entry page frames us): the same page in the browser, where games run smoother. */
const framed = window.parent !== window;
function openInBrowser() {
  // (only what says which page it is: a PS2 game's ?bios=&disc=… are the engine's, and the browser makes its own)
  const q = new URLSearchParams(location.search);
  const keep = new URLSearchParams([...q].filter(([k]) => ["room", "g", "p", "t"].includes(k)));
  const path = location.pathname + (keep.size ? `?${keep}` : "");
  parent.postMessage({ t: "cordplay:open", path }, "*");
  // (the link straight away, from the server's public address: Discord may never answer the entry page's request)
  // (without PUBLIC_URL, the address this page is at: inside Discord, the app's own *.discordsays.com one)
  const meta = document.querySelector('meta[name="hypeplay-public"]')?.getAttribute("content") ?? "";
  const own = /^https?:\/\//.test(meta);
  const base = own ? meta.replace(/\/+$/, "") : `${location.protocol}//${location.host}`;
  linkNote(true, "", base + path);
  // (Discord's address takes WebRTC away even in a browser tab: player 2's page can't connect from there)
  if (!own && /(^|\.)discordsays\.com$/.test(location.hostname) && /\/watch\/$/.test(location.pathname)) {
    const warn = document.createElement("small");
    warn.className = "cp-warn";
    warn.textContent =
      "Atenção: sem o PUBLIC_URL no servidor, o link é o endereço do Discord, que bloqueia o vídeo do jogador 2 mesmo no navegador. Quem cuida do servidor precisa configurar o PUBLIC_URL.";
    document.querySelector("#cp-top p")?.append(warn);
  }
}
// player 2's page (watch.ts) asks for it too, when joining stops
addEventListener("hypeplay:open", (e) => {
  e.preventDefault();
  openInBrowser();
});
// What the entry page says: the link as soon as it has it (none yet on the page), why when it didn't open.
window.addEventListener("message", (e) => {
  const m = e.data as { t?: unknown; why?: unknown; url?: unknown } | null;
  if (e.source !== parent || (m?.t !== "cordplay:opening" && m?.t !== "cordplay:cant-open")) return;
  // (a "didn't open" without a link keeps the one on the screen)
  const url = typeof m.url === "string" && /^https?:\/\//.test(m.url) ? m.url : document.querySelector<HTMLInputElement>("#cp-top .cp-copy input")?.value ?? "";
  const opening = m.t === "cordplay:opening";
  if (opening && (!url || document.querySelector("#cp-top .cp-copy"))) return;
  linkNote(opening, typeof m.why === "string" ? m.why : "", url);
});

/** The link to this page in the browser, to click or copy and paste there; `why` it didn't open, when it didn't. */
function linkNote(opening: boolean, why: string, url: string) {
  document.getElementById("cp-top")?.remove();
  const note = document.createElement("div");
  note.id = "cp-top";
  note.setAttribute("role", opening ? "status" : "alert");
  note.innerHTML = `<p><b></b><br><span class="why"></span></p><button type="button" aria-label="Fechar">${ICON_CLOSE}</button>`;
  note.querySelector("b")!.textContent = opening ? "Abrindo no navegador…" : "Não abriu sozinho.";
  note.querySelector(".why")!.textContent = opening
    ? "Se não abrir, clique no link ou copie e cole no navegador:"
    : `${why}${url ? " Copie o link e cole no navegador:" : ""}`;
  if (url) {
    const copy = document.createElement("div");
    copy.className = "cp-copy";
    copy.innerHTML = `<input readonly aria-label="Link para abrir no navegador"><button type="button">Copiar</button>`;
    const input = copy.querySelector("input")!;
    input.value = url;
    input.addEventListener("focus", () => input.select());
    copy.querySelector("button")!.addEventListener("click", async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      input.select();
      // (Discord's frame may not allow the clipboard API, the old copy command often still works; failing both, the
      // link stays selected for Ctrl+C)
      let done = false;
      try {
        done = document.execCommand("copy");
      } catch {}
      if (!done) done = (await navigator.clipboard?.writeText(url).then(() => true, () => false)) ?? false;
      b.textContent = done ? "Copiado!" : "Ctrl+C";
    });
    const link = document.createElement("a");
    link.className = "cp-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Abrir o link";
    // (the link carries this person's pass)
    const mine = document.createElement("small");
    mine.className = "cp-mine";
    mine.textContent = "O link entra com a sua conta: não mande para outras pessoas.";
    note.querySelector("p")!.append(copy, link, mine);
  }
  note.querySelector("button[aria-label]")!.addEventListener("click", () => note.remove());
  document.body.append(note);
}

/**
 * Drawn without the graphics card (Discord's "Hardware Acceleration" off, or a blocked GPU): the game stutters, and a
 * note at the bottom says how to fix it, once.
 */
function gpuCheck() {
  let name: string | null = "";
  try {
    name = rendererName();
  } catch {
    return;
  }
  if (!slowRenderer(name)) return;
  const note = document.createElement("div");
  note.id = "cp-gpu";
  note.setAttribute("role", "status");
  note.innerHTML = `<p><b>O jogo está sendo desenhado sem a placa de vídeo, por isso trava.</b><br>${
    framed
      ? "No Discord: Configurações → Avançado → <b>Aceleração de hardware</b> ligada (o Discord reinicia). Ou jogue no navegador."
      : "Ligue a aceleração de hardware nas configurações do navegador."
  }</p>${framed ? '<button type="button" class="cp-browser">No navegador</button>' : ""}<button type="button" class="x" aria-label="Fechar">${ICON_CLOSE}</button>`;
  note.querySelector(".cp-browser")?.addEventListener("click", openInBrowser);
  note.querySelector(".x")!.addEventListener("click", () => note.remove());
  document.body.append(note);
}

/**
 * BT3's port plays online in its own Dragon Net Battle (main menu). Opened from the library to join a friend's room
 * (?join=CODE) or to open one (?online=host), a note at the top shows the way there until it's closed.
 */
function portOnline() {
  const q = new URLSearchParams(location.search);
  const code = (q.get("join") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  const host = q.get("online") === "host";
  const way = code
    ? `No <b>menu principal</b> do jogo, escolha <b>Dragon Net Battle</b> → <b>Join a Match</b> e digite <span class="cp-code">${code}</span>.`
    : `No <b>menu principal</b> do jogo, escolha <b>Dragon Net Battle</b>: <b>Host a Match</b> cria uma sala (o código aparece na biblioteca para os amigos), <b>Join a Match</b> entra com o código de um amigo.`;
  showOnline(way);
  if (!code && !host) return;
  // (gone from the address: the game reloads itself into the match and back, and the note is for now only)
  q.delete("join");
  q.delete("online");
  history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
  const note = document.createElement("div");
  note.id = "cp-top";
  note.setAttribute("role", "status");
  note.innerHTML = `<p>${code ? `<b>Sala <span class="cp-code">${code}</span></b><br>` : "<b>Jogar online</b><br>"}${way}</p>
    <button type="button" aria-label="Fechar">${ICON_CLOSE}</button>`;
  note.querySelector("button")!.addEventListener("click", () => note.remove());
  document.body.append(note);
}

// The page's controls (this button, ps2play.ts's bar) show while the pointer moves and hide a few seconds after.
let sleep = 0;
function wake() {
  document.documentElement.classList.add("cp-awake");
  clearTimeout(sleep);
  sleep = window.setTimeout(() => document.documentElement.classList.remove("cp-awake"), 3_000);
}
document.addEventListener("pointermove", wake, { passive: true });
wake();

/** `hint` is our own markup (never a page's text). */
function showOnline(hint: string, control?: HTMLElement) {
  const box = document.querySelector<HTMLElement>("#cp-ov .cp-online");
  if (!box) return;
  box.querySelector(".cp-hint")!.innerHTML = hint;
  if (control) box.append(control);
  box.hidden = false;
}
let pending: [string, HTMLElement?] | null = null;
const sections: HTMLElement[] = [];
(window as unknown as { hypeplayOverlay: OverlayApi }).hypeplayOverlay = {
  online(hint, control) {
    if (document.getElementById("cp-ov")) showOnline(hint, control);
    else pending = [hint, control];
  },
  section(el) {
    const extra = document.querySelector("#cp-ov .cp-extra");
    if (extra) extra.append(el);
    else sections.push(el);
  },
};

fetch(prefsUrl, { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((p: Prefs | null) => {
    if (p) Object.assign(prefs, p);
    if (prefs.volume > 0) beforeMute = prefs.volume;
    apply();
  })
  .catch(() => {});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
else build();

// The home's "Pessoas" (server/presence.ts): this game's page is open, every HERE_MS, and closed (empty) on leaving.
const hereUrl = new URL("here", home);
const where = location.pathname.slice(home.pathname.length) + location.search;
const beat = () => fetch(hereUrl, { method: "POST", body: where, keepalive: true }).catch(() => {});
void beat();
setInterval(beat, 15_000);
addEventListener("pagehide", () => navigator.sendBeacon?.(hereUrl, ""));

// ---- Shift+Tab: the friends over the game (the home's Amigos, home/friends.js), like a launcher's overlay. Who's
// playing, online or offline, inviting them to this game, the invites and requests waiting (answered on the home's
// Amigos screen). Read from the home's `games` only while open. ----
interface Friend { id: string; name: string; status: string; note: string; seen?: number }
interface Around { id: string; game?: { key: string; title: string; watch?: boolean } | null; room?: { key: string; code: string } | null }
interface Social { id: string; friends: Friend[]; invites: { id: string; name: string; kind: string; title: string }[]; incoming: { id: string }[] }

/** This page's game ("ps2/<id>", "bt3"): what an invite sent from here is for. */
const gameKey = /^(.+?)\/(?:game|fast|watch)\//.exec(where)?.[1] ?? "";
const friendsPage = new URL("#amigos", home).href;
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STATUS: Record<string, string> = { online: "Online", away: "Ausente", busy: "Não perturbe" };
const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';

const FR_CSS = `
#cp-fr { position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: flex-end; background: rgb(0 0 0 / 0.62); backdrop-filter: blur(6px);
  font: 500 14px/20px "Host Grotesk", Manrope, ui-sans-serif, system-ui, sans-serif; color: #f4f2f3; animation: cp-fade 160ms ease-out; }
#cp-fr[hidden] { display: none; }
@keyframes cp-fade { from { opacity: 0; } }
#cp-fr .fr-col { width: min(380px, 100%); height: 100%; display: flex; flex-direction: column; background: #0a0a0a; box-shadow: -1px 0 0 rgb(255 255 255 / 0.08), -24px 0 60px rgb(0 0 0 / 0.5); }
#cp-fr header { display: flex; align-items: center; gap: 10px; padding: 18px 18px 14px; border-bottom: 1px solid rgb(255 255 255 / 0.08); }
#cp-fr header div { flex: 1; min-width: 0; }
#cp-fr h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 650; letter-spacing: -0.01em; }
#cp-fr header small { color: #a6a2a4; font-size: 12px; }
#cp-fr kbd { font: 600 11px/1 ui-monospace, monospace; padding: 2px 5px; border-radius: 4px; background: #232325; color: #f4f2f3; }
#cp-fr button { font: inherit; color: inherit; cursor: pointer; }
#cp-fr .x { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: #a6a2a4; }
#cp-fr .x:hover { background: #18181a; color: #f4f2f3; }
#cp-fr .fr-list { flex: 1; overflow-y: auto; padding: 6px 18px 18px; scrollbar-width: thin; scrollbar-color: rgb(255 255 255 / 0.2) transparent; }
#cp-fr h3 { margin: 16px 0 4px; font-size: 11px; line-height: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #a6a2a4; }
#cp-fr h3 span { color: #6b6869; margin-left: 4px; }
#cp-fr .fr-p { display: flex; align-items: center; gap: 10px; padding: 7px 0; min-width: 0; }
#cp-fr .fr-p.off { opacity: 0.55; }
#cp-fr .fr-av { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 12px; line-height: 1; font-weight: 700;
  background: hsl(var(--h) 38% 22%); color: hsl(var(--h) 85% 82%); }
#cp-fr .fr-who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
#cp-fr .fr-who b, #cp-fr .fr-who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cp-fr .fr-who span { color: #a6a2a4; font-size: 12px; line-height: 16px; }
#cp-fr .fr-who span.live { color: #5fd38d; }
#cp-fr .fr-inv { height: 30px; padding: 0 10px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; background: #ff5a8a; color: #120208 !important; font-weight: 700; font-size: 12px; flex: none; }
#cp-fr .fr-inv:disabled { background: #232325; color: #a6a2a4 !important; cursor: default; }
#cp-fr .fr-note { display: block; padding: 10px 12px; margin: 10px 0 0; border-radius: 8px; background: #111112; box-shadow: inset 0 0 0 1px #ff5a8a; color: #f4f2f3; text-decoration: none; font-size: 13px; }
#cp-fr .fr-empty { color: #a6a2a4; font-size: 13px; padding: 12px 0; }
#cp-fr footer { padding: 14px 18px; border-top: 1px solid rgb(255 255 255 / 0.08); }
#cp-fr footer a { color: #ff5a8a; font-weight: 700; text-decoration: none; font-size: 13px; }
#cp-fr svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#cp-fr :focus-visible { outline: 2px solid #ff5a8a; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { #cp-fr { animation: none; } }
`;

let fr: HTMLElement | null = null;
let frTimer = 0;
const invited = new Set<string>();

/** The same colour per person as the home's (friends.js' avatar). */
function frAvatar(id: string, name: string) {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 3607;
  const letters = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
  return `<div class="fr-av" style="--h:${(h * 137) % 360}" aria-hidden="true">${escHtml(letters)}</div>`;
}

function frRow(f: Friend, p: Around | undefined) {
  const on = f.status !== "offline";
  const title = p?.game?.title;
  const doing = !on ? "Offline" : title ? `${p?.game?.watch ? "Assistindo" : "Jogando"} ${title}` : STATUS[f.status] ?? "Online";
  const here = p?.game?.key === gameKey;
  const can = on && f.status !== "busy" && !!gameKey && !here;
  const btn = !can ? "" : invited.has(f.id)
    ? '<button class="fr-inv" type="button" disabled>Convidado</button>'
    : `<button class="fr-inv" type="button" data-fr-invite="${escHtml(f.id)}" aria-label="Convidar ${escHtml(f.name)} para este jogo">${ICON_SEND}Convidar</button>`;
  return `<div class="fr-p${on ? "" : " off"}">${frAvatar(f.id, f.name)}<div class="fr-who"><b>${escHtml(f.name)}</b><span class="${title && on ? "live" : ""}">${escHtml(doing)}</span></div>${btn}</div>`;
}

function frRender(body: { social: Social | null; people: Around[] } | null) {
  const list = fr?.querySelector(".fr-list");
  if (!list) return;
  const s = body?.social;
  if (!s) { list.innerHTML = `<p class="fr-empty">${body ? "Amigos indisponíveis neste servidor." : "Sem conexão com o servidor agora."}</p>`; return; }
  const around = new Map(body.people.map((p) => [p.id, p]));
  const byName = (a: Friend, b: Friend) => a.name.localeCompare(b.name);
  const playing = s.friends.filter((f) => f.status !== "offline" && around.get(f.id)?.game).sort(byName);
  const online = s.friends.filter((f) => f.status !== "offline" && !around.get(f.id)?.game).sort(byName);
  const offline = s.friends.filter((f) => f.status === "offline").sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0));
  const group = (t: string, fs: Friend[]) => (fs.length ? `<h3>${t}<span>${fs.length}</span></h3>${fs.map((f) => frRow(f, around.get(f.id))).join("")}` : "");
  const waiting = s.invites.filter((i) => i.kind === "invite");
  list.innerHTML = [
    ...waiting.map((i) => `<a class="fr-note" href="${friendsPage}"><b>${escHtml(i.name)}</b> te chamou para jogar <b>${escHtml(i.title)}</b> · responder</a>`),
    s.incoming.length ? `<a class="fr-note" href="${friendsPage}">${s.incoming.length} ${s.incoming.length === 1 ? "pedido" : "pedidos"} de amizade · ver</a>` : "",
    group("Jogando", playing),
    group("Online", online),
    group("Offline", offline),
    s.friends.length ? "" : '<p class="fr-empty">Nenhum amigo ainda. Adicione na tela de amigos da biblioteca.</p>',
  ].join("");
}

async function frLoad() {
  const body = await fetch(new URL("games", home), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  frRender(body && { social: body.social ?? null, people: body.people ?? [] });
}

function frToggle(open: boolean) {
  if (!fr) {
    const style = document.createElement("style");
    style.textContent = FR_CSS;
    document.head.append(style);
    fr = document.createElement("div");
    fr.id = "cp-fr";
    fr.hidden = true;
    fr.setAttribute("role", "dialog");
    fr.setAttribute("aria-modal", "true");
    fr.setAttribute("aria-label", "Amigos");
    fr.innerHTML = `<div class="fr-col"><header><div><h2>Amigos</h2><small><kbd>Shift</kbd>+<kbd>Tab</kbd> ou <kbd>Esc</kbd> volta ao jogo</small></div>
      <button class="x" type="button" aria-label="Fechar">${ICON_CLOSE}</button></header>
      <div class="fr-list"><p class="fr-empty">Carregando…</p></div>
      <footer><a href="${friendsPage}">Abrir a tela de amigos</a></footer></div>`;
    fr.querySelector(".x")!.addEventListener("click", () => frToggle(false));
    // (a click on the dimmed game closes it)
    fr.addEventListener("click", async (e) => {
      if (e.target === fr) return frToggle(false);
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-fr-invite]");
      if (!b) return;
      b.disabled = true;
      const r = await fetch(new URL("invite", home), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: b.dataset.frInvite, key: gameKey }) }).catch(() => null);
      if (r?.ok) invited.add(b.dataset.frInvite!);
      else b.disabled = false;
      void frLoad();
    });
    document.body.append(fr);
  }
  if (open === !fr.hidden) return;
  fr.hidden = !open;
  clearInterval(frTimer);
  if (open) {
    document.exitPointerLock?.();
    // (a fullscreen canvas would cover the overlay: the page's own fullscreen keeps it on top)
    if (document.fullscreenElement && document.fullscreenElement !== document.documentElement) void document.exitFullscreen?.().catch(() => {});
    void frLoad();
    frTimer = window.setInterval(frLoad, 5_000);
    fr.querySelector<HTMLElement>(".x")!.focus();
  } else backToGame();
}

// Before the game's own listeners (this script is in the page's <head>): Shift+Tab is ours, and while the overlay is
// open, the keys are too. Key releases still reach the game, or a key held when it opened would stay held there.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) frToggle(!fr || fr.hidden !== false);
    return;
  }
  if (!fr || fr.hidden) return;
  e.stopImmediatePropagation();
  if (e.key === "Escape") { e.preventDefault(); frToggle(false); }
}, true);
window.addEventListener("keypress", (e) => { if (fr && !fr.hidden) e.stopImmediatePropagation(); }, true);
