// overlay.js (bundled at startup, server/index.ts; slipped into every game's page after pad.js): the game's volume and
// a screen filter for old games. A small button in the top right corner (faint until the pointer comes near) opens a
// panel with a volume slider and the filter; the choice is kept on the server per person (../prefs, relative to here).
import { installVolume } from "./volume";

type Filter = "off" | "crt" | "scan";
interface Prefs {
  volume: number;
  filter: Filter;
}

const here = (document.currentScript as HTMLScriptElement | null)?.src ?? location.href;
const prefsUrl = new URL("prefs", here);
const prefs: Prefs = { volume: 0.7, filter: "off" };
// Before the game's scripts run: everything they play goes through our gain from the start.
const volume = installVolume(
  { AudioNode, AudioDestinationNode, HTMLMediaElement, document } as unknown as Parameters<typeof installVolume>[0],
  prefs.volume,
);

const FILTERS: [Filter, string][] = [["off", "Desligado"], ["crt", "TV de tubo"], ["scan", "Scanlines leves"]];

const CSS = `
#cp-ov { position: fixed; top: 10px; right: 10px; z-index: 2147483646; font: 400 13px/20px Inter, ui-sans-serif, system-ui, sans-serif; color: #f3f2fb; }
#cp-ov button { font: inherit; color: inherit; }
#cp-ov .cp-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 10px; cursor: pointer;
  background: rgb(15 13 26 / 0.72); backdrop-filter: blur(8px); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
  opacity: 0.25; transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1), background 120ms; }
#cp-ov:hover .cp-btn, #cp-ov .cp-btn:focus-visible, #cp-ov.open .cp-btn, #cp-ov.near .cp-btn { opacity: 1; }
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
#cp-crt { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; display: none; }
html[data-cp-filter=crt] #cp-crt, html[data-cp-filter=scan] #cp-crt { display: block; }
html[data-cp-filter=crt] #cp-crt {
  background:
    radial-gradient(ellipse at center, transparent 58%, rgb(0 0 0 / 0.55) 100%),
    repeating-linear-gradient(to bottom, rgb(0 0 0 / 0.30) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgb(255 40 40 / 0.06) 0 1px, rgb(40 255 80 / 0.05) 1px 2px, rgb(60 90 255 / 0.06) 2px 3px);
  box-shadow: inset 0 0 120px rgb(0 0 0 / 0.6); animation: cp-flicker 4s steps(2) infinite; }
html[data-cp-filter=scan] #cp-crt { background: repeating-linear-gradient(to bottom, rgb(0 0 0 / 0.16) 0 1px, transparent 1px 3px); }
html[data-cp-filter=crt] canvas, html[data-cp-filter=crt] video { filter: contrast(1.1) saturate(1.18) brightness(1.06) blur(0.35px); }
@keyframes cp-flicker { 50% { opacity: 0.94; } }
@media (prefers-reduced-motion: reduce) { #cp-crt { animation: none !important; } #cp-ov .cp-panel { animation: none !important; } }
`;

const ICON_ON = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
const ICON_TUNE = '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';

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
      <div class="cp-label"><span>Volume</span><span class="cp-pct"></span></div>
      <div class="cp-vol"><button class="cp-mute" type="button"></button><input type="range" min="0" max="100" step="1" aria-label="Volume do jogo"></div>
      <div class="cp-label"><span>Filtro de imagem</span></div>
      <div class="cp-seg" role="group" aria-label="Filtro de imagem">${FILTERS.map(([f, name]) => `<button type="button" data-filter="${f}">${name}</button>`).join("")}</div>
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
  // The button shows up when the pointer comes near the corner, and fades away again.
  document.addEventListener("pointermove", (e) => ov.classList.toggle("near", innerWidth - e.clientX < 120 && e.clientY < 90), { passive: true });
  apply();
}

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
