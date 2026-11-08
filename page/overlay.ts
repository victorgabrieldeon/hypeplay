// overlay.js (bundled at startup, server/index.ts; slipped into every game's page after pad.js): a small button in the
// top right corner (shown while the pointer moves, gone after a few still seconds, like a video player's controls)
// opens the settings panel, in tabs (Vídeo, Áudio, CPU, Sistema, Multiplayer; the game's page adds its own parts):
// a screen filter for old games, the game's volume, how to play it online and the friends, and the way back to the
// library. The volume and filter are kept on the server per person (prefs, next to this script).
import { rendererName, slowRenderer } from "./gpu";
import { installVolume } from "./volume";

type Filter = "off" | "crt" | "scan";
interface Prefs {
  volume: number;
  filter: Filter;
}

/** The panel's tabs; one with nothing in it isn't shown. */
export type Tab = "video" | "audio" | "cpu" | "system" | "online";
const TABS: [Tab, string][] = [["video", "Vídeo"], ["audio", "Áudio"], ["cpu", "CPU"], ["system", "Sistema"], ["online", "Multiplayer"]];

/** What a game's page adds to the panel: its online (ps2play.ts: the room it opens), and parts of its own, by tab. */
export interface OverlayApi {
  online(hint: string, control?: HTMLElement): void;
  section(el: HTMLElement, tab: Tab): void;
  /** Something changed that the game takes only when it opens again: the panel says so, with "Reabrir agora". */
  reopen(): void;
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

// (Mosaico, DESIGN.md: the same black, coral and Host Grotesk as the library; served from the library's fonts/)
const font = (file: string) => new URL(`fonts/${file}`, home).href;
const CSS = `
@font-face { font-family: "Host Grotesk"; font-weight: 300 800; font-display: swap; src: url("${font("host-grotesk-latin-wght-normal.woff2")}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 100 800; font-display: swap; src: url("${font("jetbrains-mono-latin-wght-normal.woff2")}") format("woff2"); }
#cp-ov, #cp-top, #cp-gpu { font: 500 13px/20px "Host Grotesk", ui-sans-serif, system-ui, sans-serif; color: #f4f2f3; -webkit-font-smoothing: antialiased; }
#cp-ov { position: fixed; top: 10px; right: 10px; z-index: 2147483646; }
#cp-ov button { font: inherit; color: inherit; cursor: pointer; }
#cp-ov svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#cp-ov :focus-visible, #cp-top :focus-visible, #cp-gpu :focus-visible { outline: 2px solid #ff8fb0; outline-offset: 2px; }
#cp-ov .cp-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 8px; background: rgb(0 0 0 / 0.72);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.14); opacity: 0; transition: opacity 220ms cubic-bezier(0.2, 0.8, 0.2, 1), background 120ms; }
#cp-ov .cp-btn:hover { background: #18181a; }
html.cp-awake #cp-ov .cp-btn, #cp-ov:hover .cp-btn, #cp-ov .cp-btn:focus-visible { opacity: 1; }
#cp-ov.open .cp-btn { visibility: hidden; }
/* the panel: a column on the right, like the library's drawer and the friends (Shift+Tab); the game stays in sight */
#cp-ov .cp-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100%); display: none; flex-direction: column; background: #0a0a0a;
  box-shadow: -1px 0 0 rgb(255 255 255 / 0.14), -24px 0 60px rgb(0 0 0 / 0.5); }
#cp-ov.open .cp-panel { display: flex; animation: cp-slide 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes cp-slide { from { opacity: 0; transform: translateX(16px); } }
@keyframes cp-rise { from { opacity: 0; transform: translateY(-6px); } }
#cp-ov header { display: flex; align-items: center; gap: 10px; padding: 18px 18px 8px; }
/* the tabs: like the library's bar, the chosen one in ink with a coral line under it */
#cp-ov .cp-tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid rgb(255 255 255 / 0.08); overflow-x: auto; scrollbar-width: none; }
#cp-ov .cp-tabs button { position: relative; flex: none; height: 40px; padding: 0 8px; border: 0; background: none; color: #a6a2a4; font-size: 13px; font-weight: 600;
  transition: color 120ms; }
#cp-ov .cp-tabs button:hover { color: #f4f2f3; }
#cp-ov .cp-tabs button[aria-selected=true] { color: #f4f2f3; }
#cp-ov .cp-tabs button[aria-selected=true]::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; background: #ff5a8a; }
#cp-ov .cp-tabs button:focus-visible { outline-offset: -2px; }
#cp-ov .cp-tabs button[hidden] { display: none; }
#cp-ov header div { flex: 1; min-width: 0; }
#cp-ov h2 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 650; letter-spacing: -0.01em; }
#cp-ov header small { display: block; color: #a6a2a4; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cp-ov kbd { font: 600 11px/1 "JetBrains Mono", ui-monospace, monospace; padding: 2px 5px; border-radius: 4px; background: #232325; color: #f4f2f3; }
#cp-ov .x { width: 32px; height: 32px; display: grid; place-items: center; flex: none; border: 0; border-radius: 6px; background: none; color: #a6a2a4; }
#cp-ov .x:hover { background: #18181a; color: #f4f2f3; }
#cp-ov .cp-body { flex: 1; overflow-y: auto; padding: 0 18px 8px; scrollbar-width: thin; scrollbar-color: rgb(255 255 255 / 0.2) transparent; }
/* each part of a tab (ours, then the game's): a titled block between thin lines */
#cp-ov .cp-pane[hidden], #cp-ov .cp-sec[hidden], #cp-ov .cp-group[hidden] { display: none; }
#cp-ov .cp-sec { display: flex; flex-direction: column; gap: 14px; padding: 16px 0; border-top: 1px solid rgb(255 255 255 / 0.08); }
#cp-ov .cp-pane > .cp-sec:first-child, #cp-ov .cp-pane > .cp-sec[hidden] + .cp-sec { border-top: 0; }
#cp-ov h3 { margin: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px; line-height: 16px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase; color: #a6a2a4; }
#cp-ov .cp-group { display: flex; flex-direction: column; gap: 6px; }
#cp-ov .cp-sub { color: #f4f2f3; font-weight: 600; font-size: 13px; }
#cp-ov .cp-hint { margin: 0; color: #a6a2a4; font-size: 12px; line-height: 18px; }
#cp-ov .cp-hint b { color: #f4f2f3; }
#cp-ov .cp-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 2px; border-radius: 8px; background: #111112;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08); }
#cp-ov .cp-seg button { min-width: 0; border: 0; border-radius: 6px; padding: 7px 4px; background: none; color: #a6a2a4; font-size: 12px; font-weight: 600; transition: background 120ms, color 120ms; }
#cp-ov .cp-seg button:hover:not(:disabled, [aria-pressed=true]) { background: #18181a; color: #f4f2f3; }
#cp-ov .cp-seg button[aria-pressed=true] { background: #ff5a8a; color: #000; }
#cp-ov .cp-seg button:disabled { opacity: 0.45; cursor: default; }
#cp-ov .cp-vol { display: flex; align-items: center; gap: 10px; }
#cp-ov .cp-pct { font: 500 12px/16px "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0; text-transform: none; color: #f4f2f3; }
#cp-ov .cp-mute { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; background: #232325; }
#cp-ov .cp-mute:hover { background: #2c2c2f; }
#cp-ov input[type=range] { flex: 1; accent-color: #ff5a8a; height: 4px; cursor: pointer; }
#cp-ov .cp-speed { font: 500 12px/16px "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0; text-transform: none; color: #3ddc84; font-variant-numeric: tabular-nums; }
#cp-ov .cp-speed.slow, #cp-ov .cp-slow { color: #f5a524; }
/* "applies when the game opens again": a note in coral's outline, with the way to do it now */
#cp-ov .cp-reopen { margin: 0; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; background: #111112; box-shadow: inset 0 0 0 1px #ff5a8a; color: #f4f2f3; }
#cp-ov .cp-reopen[hidden] { display: none; }
#cp-ov .cp-reopen button { flex: none; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: #ff5a8a; color: #000; font-weight: 700; font-size: 12px; }
#cp-ov .cp-reopen button:hover { background: #ff7aa1; }
#cp-ov .cp-quiet { align-self: flex-start; margin-top: -4px; padding: 0; border: 0; background: none; color: #a6a2a4; font-size: 12px; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
#cp-ov .cp-quiet:hover { color: #f4f2f3; }
#cp-ov .cp-online button { height: 36px; border: 0; border-radius: 6px; background: #ff5a8a; color: #000; font-weight: 700; transition: background 120ms; }
#cp-ov .cp-online button:hover:not(:disabled) { background: #ff7aa1; }
#cp-ov .cp-online button:disabled { background: #232325; color: #a6a2a4; cursor: default; }
#cp-ov footer { display: flex; flex-direction: column; gap: 8px; padding: 14px 18px; border-top: 1px solid rgb(255 255 255 / 0.08); }
#cp-ov .cp-home, #cp-ov .cp-browser, #cp-ov .cp-friends { display: flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 14px; border: 0; border-radius: 6px;
  background: none; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.14); color: #f4f2f3; text-decoration: none; font-weight: 700; transition: background 120ms; }
#cp-ov .cp-home:hover, #cp-ov .cp-browser:hover:not(:disabled), #cp-ov .cp-friends:hover { background: #18181a; }
#cp-ov .cp-browser:disabled { color: #a6a2a4; cursor: default; }
.cp-code { font: 600 13px/18px "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.14em; color: #ff8fb0; padding: 1px 6px; border-radius: 4px; background: #232325; }
/* the notes over the game (the link to the browser, no graphics card, the online's way): floating, at the top */
#cp-top, #cp-gpu { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; display: flex; align-items: flex-start; gap: 10px;
  width: max-content; max-width: min(520px, calc(100% - 120px)); padding: 12px 10px 12px 16px; border-radius: 12px; background: #0a0a0a;
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.14); color: #a6a2a4; animation: cp-rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
#cp-gpu { top: auto !important; bottom: 16px; align-items: center; }
#cp-top p, #cp-gpu p { margin: 0; }
#cp-top b, #cp-gpu b { color: #f4f2f3; }
#cp-top button, #cp-gpu .x { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: none; color: #a6a2a4; cursor: pointer; }
#cp-top button:hover, #cp-gpu .x:hover { color: #f4f2f3; background: #18181a; }
#cp-top svg, #cp-gpu svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
#cp-top .cp-copy { display: flex; gap: 6px; margin-top: 8px; }
#cp-top .cp-copy input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 0; border-radius: 6px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.14);
  background: #111112; color: #f4f2f3; font: 500 12px/32px "JetBrains Mono", ui-monospace, monospace; }
#cp-top .cp-copy button { width: auto; height: 32px; padding: 0 12px; background: #ff5a8a; color: #000; font: 700 13px/32px "Host Grotesk", ui-sans-serif, system-ui, sans-serif; }
#cp-top .cp-copy button:hover { background: #ff7aa1; color: #000; }
#cp-top .cp-link { display: inline-block; margin-top: 8px; color: #ff8fb0; font-weight: 700; }
#cp-top .cp-mine { display: block; margin-top: 6px; color: #a6a2a4; font-size: 11px; }
#cp-top .cp-warn { display: block; margin-top: 8px; color: #f5a524; font-size: 12px; line-height: 18px; }
#cp-gpu .cp-browser { flex: none; height: 32px; padding: 0 12px; border: 0; border-radius: 6px; background: #ff5a8a; color: #000; font: 700 13px/32px "Host Grotesk", ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
#cp-gpu .cp-browser:hover { background: #ff7aa1; }
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
@media (prefers-reduced-motion: reduce) { #cp-ov .cp-panel, #cp-top, #cp-gpu { animation: none !important; } }
/* "Na tela": the pad with what's pressed, in a bottom corner, and the FPS, left of the panel's button */
#cp-pad, #cp-fps { position: fixed; z-index: 2147483645; pointer-events: none; display: none; }
#cp-pad { bottom: 28px; left: 16px; width: 200px; }
html[data-cp-pad=left] #cp-pad, html[data-cp-pad=right] #cp-pad, html[data-cp-fps=on] #cp-fps { display: block; }
html[data-cp-pad=right] #cp-pad { left: auto; right: 16px; }
#cp-pad .body { fill: rgb(0 0 0 / 0.55); stroke: rgb(255 255 255 / 0.22); }
#cp-pad .b { fill: rgb(255 255 255 / 0.1); stroke: rgb(255 255 255 / 0.35); }
#cp-pad .b.on { fill: #ff5a8a; stroke: #ff5a8a; }
#cp-pad .g { fill: none; stroke: #f4f2f3; stroke-width: 1.2; }
#cp-fps { top: 10px; right: 54px; padding: 3px 8px; border-radius: 6px; background: rgb(0 0 0 / 0.6); color: #3ddc84;
  font: 600 12px/18px "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
`;

// What "Na tela" shows: kept in this browser.
const SHOW_PREF = "hypeplay.show";
const SHOW: [id: string, title: string, hint: string, choices: [string, string][]][] = [
  ["pad", "Controle na tela", "Um controle de PS2 no canto que acende os botões que você aperta.", [["off", "Desligado"], ["left", "Esquerda"], ["right", "Direita"]]],
  ["opacity", "Transparência do controle", "", [["35", "Bem leve"], ["65", "Média"], ["100", "Sólido"]]],
  ["fps", "FPS na tela", "Quantos quadros por segundo o jogo mostra, no canto de cima.", [["off", "Desligado"], ["on", "Ligado"]]],
];
const show: Record<string, string> = { pad: "off", opacity: "65", fps: "off" };
try {
  const saved = JSON.parse(localStorage.getItem(SHOW_PREF) ?? "{}");
  for (const [id, , , choices] of SHOW) if (choices.some(([v]) => v === saved?.[id])) show[id] = saved[id];
} catch {}

// The pad's buttons, by the standard layout's index (padmap.ts STANDARD); 10 and 11 are the sticks, moved by the axes.
const PAD_SVG = `<svg viewBox="0 0 200 124" aria-hidden="true">
  <rect class="b" data-b="6" x="38" y="2" width="32" height="8" rx="3"/><rect class="b" data-b="4" x="38" y="12" width="32" height="8" rx="3"/>
  <rect class="b" data-b="7" x="130" y="2" width="32" height="8" rx="3"/><rect class="b" data-b="5" x="130" y="12" width="32" height="8" rx="3"/>
  <path class="body" d="M50 22h100a30 30 0 0 1 30 28l14 52a14 14 0 0 1-26 8l-20-22H52l-20 22a14 14 0 0 1-26-8l14-52a30 30 0 0 1 30-28z"/>
  <rect class="b" data-b="12" x="45" y="33" width="10" height="12" rx="2"/><rect class="b" data-b="13" x="45" y="55" width="10" height="12" rx="2"/>
  <rect class="b" data-b="14" x="33" y="45" width="12" height="10" rx="2"/><rect class="b" data-b="15" x="55" y="45" width="12" height="10" rx="2"/>
  <circle class="b" data-b="3" cx="150" cy="37" r="6.5"/><circle class="b" data-b="0" cx="150" cy="63" r="6.5"/>
  <circle class="b" data-b="2" cx="137" cy="50" r="6.5"/><circle class="b" data-b="1" cx="163" cy="50" r="6.5"/>
  <path class="g" d="M150 33.5l3.5 6h-7zM147.5 60.5l5 5M152.5 60.5l-5 5"/><rect class="g" x="134.5" y="47.5" width="5" height="5"/><circle class="g" cx="163" cy="50" r="3"/>
  <rect class="b" data-b="8" x="82" y="46" width="13" height="6" rx="3"/><rect class="b" data-b="9" x="105" y="46" width="13" height="6" rx="3"/>
  <circle class="body" cx="78" cy="78" r="13"/><circle class="body" cx="122" cy="78" r="13"/>
  <circle class="b" data-b="10" cx="78" cy="78" r="8"/><circle class="b" data-b="11" cx="122" cy="78" r="8"/>
</svg>`;

let raf = 0;
let frames = 0;
let fpsAt = 0;
/** Each frame while something shows: the first pad's buttons and sticks (pad.js' mapped pads, keyboard too), the FPS once a second. */
function tick(t: number) {
  raf = 0;
  if (show.pad === "off" && show.fps === "off") return;
  raf = requestAnimationFrame(tick);
  frames++;
  if (show.fps === "on" && t - fpsAt >= 1000) {
    // (a PS2 game's own count, from the emulator; any other game, the page's frames)
    const emu = document.getElementById("r-fps")?.textContent?.trim() ?? "";
    document.getElementById("cp-fps")!.textContent = `${/^\d/.test(emu) ? emu : fpsAt ? Math.round((frames * 1000) / (t - fpsAt)) : "–"} FPS`;
    [frames, fpsAt] = [0, t];
  }
  if (show.pad === "off") return;
  let p: Gamepad | null | undefined = null;
  try {
    p = [...navigator.getGamepads()].find((g) => g?.connected);
  } catch {}
  for (const el of document.querySelectorAll<SVGElement>("#cp-pad [data-b]")) {
    const i = Number(el.dataset.b);
    const on = !!p?.buttons[i]?.pressed;
    if (el.classList.contains("on") !== on) el.classList.toggle("on", on);
    if (i < 10 || i > 11) continue;
    const [x = 0, y = 0] = p?.axes.slice((i - 10) * 2, (i - 10) * 2 + 2) ?? [];
    el.setAttribute("transform", `translate(${(x * 5).toFixed(1)} ${(y * 5).toFixed(1)})`);
  }
}

function applyShow() {
  const root = document.documentElement.dataset;
  [root.cpPad, root.cpFps] = [show.pad, show.fps];
  const pad = document.getElementById("cp-pad");
  if (pad) pad.style.opacity = String(Number(show.opacity) / 100);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#cp-ov [data-show]")) b.setAttribute("aria-pressed", String(show[b.dataset.show!] === b.dataset.value));
  for (const g of document.querySelectorAll<HTMLElement>("#cp-ov [data-show-group=opacity]")) g.hidden = show.pad === "off";
  if (!raf) [frames, fpsAt, raf] = [0, 0, requestAnimationFrame(tick)];
}

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
  ov.innerHTML = `<button class="cp-btn" type="button" aria-expanded="false" aria-controls="cp-panel" aria-label="Configurações do jogo">${ICON_TUNE}</button>
    <div class="cp-panel" id="cp-panel" role="dialog" aria-labelledby="cp-title">
      <header><div><h2 id="cp-title">Configurações</h2><small><kbd>Esc</kbd> volta ao jogo</small></div>
        <button class="x" type="button" aria-label="Fechar">${ICON_CLOSE}</button></header>
      <div class="cp-tabs" role="tablist" aria-label="Configurações">${TABS.map(([t, name]) => `<button type="button" role="tab" id="cp-tab-${t}" data-tab="${t}" aria-controls="cp-pane-${t}">${name}</button>`).join("")}</div>
      <div class="cp-body">${TABS.map(([t]) => `<div class="cp-pane" role="tabpanel" id="cp-pane-${t}" data-pane="${t}" aria-labelledby="cp-tab-${t}"></div>`).join("")}</div>
      <footer><p class="cp-hint cp-reopen" hidden><span>Vale quando o jogo abrir de novo (o que não foi salvo se perde).</span><button type="button">Reabrir agora</button></p>
        ${framed ? '<button class="cp-browser" type="button">Jogar no navegador (mais liso)</button>' : ""}<a class="cp-home" href="${home.href}">${ICON_BACK}Voltar para a biblioteca</a></footer>
    </div>`;
  document.body.append(crt, ov);
  pane("video").innerHTML = `<section class="cp-sec"><h3>Tela</h3><div class="cp-group"><div class="cp-sub">Filtro de tela</div>
      <div class="cp-seg cp-filter" role="group" aria-label="Filtro de tela">${FILTERS.map(([f, name]) => `<button type="button" data-filter="${f}">${name}</button>`).join("")}</div>
      <p class="cp-hint">Desenhado por cima do jogo: não pesa nada.</p></div></section>
    <section class="cp-sec cp-show"><h3>Na tela</h3>${SHOW.map(([id, title, hint, choices]) => `<div class="cp-group" data-show-group="${id}"><div class="cp-sub">${title}</div>
      <div class="cp-seg" role="group" aria-label="${title}">${choices.map(([v, name]) => `<button type="button" data-show="${id}" data-value="${v}">${name}</button>`).join("")}</div>
      ${hint ? `<p class="cp-hint">${hint}</p>` : ""}</div>`).join("")}</section>`;
  const pad = document.createElement("div");
  pad.id = "cp-pad";
  pad.innerHTML = PAD_SVG;
  const fps = document.createElement("div");
  fps.id = "cp-fps";
  fps.textContent = "– FPS";
  document.body.append(pad, fps);
  ov.querySelector(".cp-show")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-show]");
    if (!b) return;
    show[b.dataset.show!] = b.dataset.value!;
    try {
      localStorage.setItem(SHOW_PREF, JSON.stringify(show));
    } catch {}
    applyShow();
  });
  applyShow();
  pane("audio").innerHTML = `<section class="cp-sec"><h3><span>Volume</span><span class="cp-pct"></span></h3>
      <div class="cp-vol"><button class="cp-mute" type="button"></button><input type="range" min="0" max="100" step="1" aria-label="Volume do jogo"></div>
      <p class="cp-hint">Guardado na sua conta: vale em todos os jogos e aparelhos.</p></section>`;
  pane("online").innerHTML = `<section class="cp-sec cp-online" hidden><h3>Jogar online</h3><p class="cp-hint"></p></section>
    <section class="cp-sec"><h3>Amigos</h3><p class="cp-hint">Quem está jogando agora, e convidar alguém para este jogo. Durante o jogo, <kbd>Shift</kbd>+<kbd>Tab</kbd> também abre.</p>
      <button class="cp-friends" type="button">Ver amigos</button></section>`;
  const btn = ov.querySelector<HTMLButtonElement>(".cp-btn")!;
  const toggle = (open: boolean) => {
    if (open === ov.classList.contains("open")) return;
    ov.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) ov.querySelector<HTMLElement>(".x")!.focus();
    else backToGame();
  };
  ov.querySelector(".x")!.addEventListener("click", () => toggle(false));
  ov.querySelector(".cp-friends")!.addEventListener("click", () => {
    toggle(false);
    frToggle(true);
  });
  ov.querySelector(".cp-reopen button")!.addEventListener("click", () => location.reload());
  const tabs = ov.querySelector<HTMLElement>(".cp-tabs")!;
  tabs.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
    if (t) selectTab(t);
  });
  // (the tabs' keys, as in any tab list: the arrows go to the next shown one, Home and End to the ends)
  tabs.addEventListener("keydown", (e) => {
    const shown = [...tabs.querySelectorAll<HTMLElement>("[data-tab]:not([hidden])")];
    const at = shown.findIndex((b) => b.dataset.tab === tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: shown.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const b = shown[(to + shown.length) % shown.length];
    selectTab(b.dataset.tab as Tab);
    b.focus();
  });
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
  ov.querySelector(".cp-filter")!.addEventListener("click", (e) => {
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
  for (const [el, t] of sections) pane(t).append(el);
  if (pending) showOnline(...pending);
  else if (document.querySelector('meta[name="hypeplay-online"]')?.getAttribute("content") === "menu") portOnline();
  if (reopenWanted) showReopen();
  selectTab(tab);
  gpuCheck();
}

const pane = (t: Tab) => document.getElementById(`cp-pane-${t}`)!;
let tab: Tab = "video";
/** Shows tab `t` (or the first one with something in it), and only the tabs with something in them. */
function selectTab(t: Tab) {
  const full = (x: Tab) => [...pane(x).children].some((c) => !(c as HTMLElement).hidden);
  tab = full(t) ? t : TABS.find(([x]) => full(x))?.[0] ?? t;
  for (const [x] of TABS) {
    const b = document.getElementById(`cp-tab-${x}`)!;
    b.hidden = !full(x);
    b.setAttribute("aria-selected", String(x === tab));
    b.tabIndex = x === tab ? 0 : -1;
    pane(x).hidden = x !== tab;
  }
}

let reopenWanted = false;
function showReopen() {
  reopenWanted = true;
  const note = document.querySelector<HTMLElement>("#cp-ov .cp-reopen");
  if (note) note.hidden = false;
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
  selectTab(tab);
}
let pending: [string, HTMLElement?] | null = null;
const sections: [HTMLElement, Tab][] = [];
(window as unknown as { hypeplayOverlay: OverlayApi }).hypeplayOverlay = {
  online(hint, control) {
    if (document.getElementById("cp-ov")) showOnline(hint, control);
    else pending = [hint, control];
  },
  section(el, t) {
    if (!document.getElementById("cp-ov")) return void sections.push([el, t]);
    pane(t).append(el);
    selectTab(tab);
  },
  reopen: showReopen,
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
  // (inside the open settings panel, Shift+Tab is the keyboard's way back through its controls)
  const inPanel = !!document.querySelector("#cp-ov.open")?.contains(document.activeElement);
  if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !inPanel) {
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
