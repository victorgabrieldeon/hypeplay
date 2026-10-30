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

/** What a game's page adds to the panel: its online (ps2play.ts: the room it opens). */
export interface OverlayApi {
  online(hint: string, control?: HTMLElement): void;
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
  parent.postMessage({ t: "cordplay:open", path: location.pathname + (keep.size ? `?${keep}` : "") }, "*");
}
// It didn't open (no PUBLIC_URL, or Discord didn't): why, and the link to copy into the browser.
window.addEventListener("message", (e) => {
  const m = e.data as { t?: unknown; why?: unknown; url?: unknown } | null;
  if (e.source !== parent || m?.t !== "cordplay:cant-open") return;
  document.getElementById("cp-top")?.remove();
  const note = document.createElement("div");
  note.id = "cp-top";
  note.setAttribute("role", "alert");
  note.innerHTML = `<p><b>Não deu para abrir no navegador.</b><br><span class="why"></span></p><button type="button" aria-label="Fechar">${ICON_CLOSE}</button>`;
  note.querySelector(".why")!.textContent = typeof m.why === "string" ? m.why : "";
  if (typeof m.url === "string" && /^https?:\/\//.test(m.url)) {
    const copy = document.createElement("div");
    copy.className = "cp-copy";
    copy.innerHTML = `<input readonly aria-label="Link para abrir no navegador"><button type="button">Copiar</button>`;
    const input = copy.querySelector("input")!;
    input.value = m.url;
    copy.querySelector("button")!.addEventListener("click", async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      input.select();
      // (Discord's frame may not allow the clipboard: then the link stays selected for Ctrl+C)
      b.textContent = await navigator.clipboard?.writeText(m.url as string).then(() => "Copiado", () => "Ctrl+C").catch(() => "Ctrl+C") ?? "Ctrl+C";
    });
    note.querySelector("p")!.append(copy);
  }
  note.querySelector("button[aria-label]")!.addEventListener("click", () => note.remove());
  document.body.append(note);
});

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
(window as unknown as { hypeplayOverlay: OverlayApi }).hypeplayOverlay = {
  online(hint, control) {
    if (document.getElementById("cp-ov")) showOnline(hint, control);
    else pending = [hint, control];
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
