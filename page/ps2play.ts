import { createCardSync, heldByOtherTab, type CardStore } from "./cardsync";
import type { OverlayApi } from "./overlay";
import { BOOT_PARAMS, bootParams, perfSections, readBoot } from "./perf";
import { syncPipelines } from "./pipesync";
import { roomButton } from "./stream";

// ps2play.js (bundled at startup, server/index.ts; put in TabStationToo's page by server/ps2page.ts, before its
// app.js, which this loads itself once ready). It makes TabStationToo the PS2 games' player:
//
//   - without cross-origin isolation (Discord didn't give it), nothing loads: "Abrir no navegador" instead;
//   - the boot address: the server's BIOS and this game's disc (?bios=, ?disc=, same origin as the engine wants);
//   - the person's memory card from the server in slot 1, and back to the server whenever the game saves;
//   - our design: TabStationToo's console and menus hidden, the game on the whole window, our slim bar.

const CARD_ID = "cordplay";
const CARD_BYTES = 8_650_752;
/**
 * A card the server hasn't got yet (cardsync.ts), in the emulator's own database: one per game, since every game shares
 * this origin's database and another game's unsent card would go up as this one's save. (ps2-builder/patch.ts too.)
 */
const DIRTY_KEY = `cordplay-unsent:${/\/ps2\/([^/]+)\/game\//.exec(location.pathname)?.[1] ?? ""}`;

const FONT = `"Host Grotesk", ui-sans-serif, system-ui, sans-serif`;
// (Mosaico, DESIGN.md: the library's black, coral and Host Grotesk)
const STYLE = `
@font-face { font-family: "Host Grotesk"; font-weight: 300 800; font-display: swap; src: url("../../../fonts/host-grotesk-latin-wght-normal.woff2") format("woff2"); }
html, body { background: #000 !important; overflow: hidden !important; }
body > * { visibility: hidden !important; }
#screen, #screen *, #slate, #slate *, #cp-bar, #cp-bar *, #cp-license, #cp-license *, #cp-ov, #cp-ov *, #cp-crt, #cp-pad, #cp-pad *, #cp-fps, #cp-note, #cp-note * { visibility: visible !important; }
/* the whole 4:3 picture, as big as the window takes, centered (TabStationToo's own 4:3 box would overflow a wide window) */
#screen { position: fixed !important; inset: 0 !important; z-index: 10 !important; margin: auto !important; border: 0 !important; border-radius: 0 !important;
  background: #000 !important; display: grid !important; place-items: center !important; transform: none !important;
  width: min(100vw, 100vh * 4 / 3) !important; height: min(100vh, 100vw * 3 / 4) !important; aspect-ratio: auto !important;
  max-width: none !important; max-height: none !important; translate: none !important; scale: none !important; rotate: none !important; }
#screen canvas { width: 100% !important; height: 100% !important; object-fit: contain !important; max-width: none !important; max-height: none !important; }
#slate { position: fixed !important; left: 50% !important; bottom: 32px !important; top: auto !important; transform: translateX(-50%) !important; z-index: 20 !important;
  width: min(460px, calc(100% - 32px)) !important; background: #0a0a0a !important; color: #f4f2f3 !important; border-radius: 12px !important;
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.14) !important; padding: 16px 20px !important;
  font: 500 15px/24px ${FONT} !important; text-align: center; }
#slate[hidden] { display: none !important; }
#slate h1, #slate h2 { font: 650 17px/26px ${FONT} !important; letter-spacing: -0.01em; color: #f4f2f3 !important; margin: 0 0 4px !important; }
#slate p, #slate .fine { color: #a6a2a4 !important; }
#slate button { font: 700 14px/1 ${FONT} !important; border: 0 !important; border-radius: 6px !important; height: 36px; padding: 0 14px;
  background: none !important; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.14) !important; color: #f4f2f3 !important; cursor: pointer; }
#slate button:hover { background: #18181a !important; }
#slate .btn-primary { background: #ff5a8a !important; box-shadow: none !important; color: #000 !important; }
#slate .btn-primary:hover { background: #ff7aa1 !important; }
#slate .cmd, #slate #dev-copy, #slate #slate-library, #slate #slate-disc, #slate #slate-remove { display: none !important; }
#cp-bar { position: fixed; top: 10px; left: 10px; z-index: 2147483646; display: flex; align-items: center; gap: 6px; padding: 4px;
  border-radius: 8px; background: rgb(0 0 0 / 0.72); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.14);
  font: 600 13px/20px ${FONT}; color: #f4f2f3; opacity: 0; transition: opacity 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
/* (overlay.js marks the page awake while the pointer moves; a room waiting for its friend keeps the bar up) */
html.cp-awake #cp-bar, #cp-bar:hover, #cp-bar:focus-within, #cp-bar.waiting { opacity: 1; }
#cp-bar a, #cp-bar button { display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: none;
  color: inherit; text-decoration: none; font: inherit; cursor: pointer; transition: background 120ms; }
#cp-bar a:hover, #cp-bar button:hover { background: #18181a; }
#cp-bar button { background: #ff5a8a; color: #000; font-weight: 700; }
#cp-bar button:hover { background: #ff7aa1; }
#cp-bar button:disabled { background: #232325; color: #a6a2a4; cursor: default; }
#cp-bar a:focus-visible, #cp-bar button:focus-visible, #cp-note :focus-visible { outline: 2px solid #ff8fb0; outline-offset: 2px; }
#cp-bar b { font: 650 14px/20px ${FONT}; padding: 0 6px; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cp-license { position: fixed; right: 12px; bottom: 6px; z-index: 30; margin: 0; font: 500 11px/16px ${FONT}; color: #a6a2a4; }
#cp-license a { color: #a6a2a4; }
#cp-note { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: #000;
  font: 500 15px/24px ${FONT}; color: #f4f2f3; text-align: center; }
#cp-note > div { max-width: 460px; display: flex; flex-direction: column; gap: 12px; align-items: center; }
#cp-note h1 { font: 650 22px/28px ${FONT}; letter-spacing: -0.02em; margin: 0; }
#cp-note p { color: #a6a2a4; margin: 0; }
#cp-note button { height: 42px; padding: 0 18px; border: 0; border-radius: 6px; background: #ff5a8a; color: #000; font: 700 15px/42px ${FONT}; cursor: pointer; }
#cp-note button:hover { background: #ff7aa1; }
#cp-note a { color: #a6a2a4; font: 600 14px/20px ${FONT}; text-decoration: none; }
#cp-note a:hover { color: #f4f2f3; }
`;

function style() {
  const s = document.createElement("style");
  s.textContent = STYLE;
  document.head.append(s);
}

/** A full-window message in our design (no game behind it). */
function note(title: string, text: string, action?: { label: string; run: () => void }) {
  const show = () => {
    const n = document.createElement("div");
    n.id = "cp-note";
    n.innerHTML = `<div><h1></h1><p></p>${action ? "<button type=\"button\"></button>" : ""}<a href="../../../">← Voltar para a biblioteca</a></div>`;
    n.querySelector("h1")!.textContent = title;
    n.querySelector("p")!.textContent = text;
    if (action) {
      const b = n.querySelector("button")!;
      b.textContent = action.label;
      b.addEventListener("click", action.run);
    }
    document.body.append(n);
  };
  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show);
}

/** A small notice at the bottom, in our design, that leaves the game playable. */
function warn(text: string) {
  const n = document.createElement("p");
  n.id = "cp-warn";
  n.textContent = text;
  n.style.cssText =
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483646;margin:0;max-width:min(560px,calc(100% - 32px));padding:10px 14px;border-radius:12px;background:#0a0a0a;color:#f5a524;font:500 13px/20px 'Host Grotesk',ui-sans-serif,system-ui,sans-serif;box-shadow:0 18px 40px rgb(0 0 0 / .6),0 0 0 1px rgb(255 255 255 / .14);visibility:visible";
  document.body.append(n);
  setTimeout(() => n.remove(), 12_000);
}

/** `open`: opened from the library's "Abrir uma sala": the room opens straight away. */
function bar(open: boolean) {
  const b = document.createElement("div");
  b.id = "cp-bar";
  b.innerHTML = '<a href="../../../" aria-label="Voltar para a biblioteca">← Biblioteca</a><b></b>';
  b.querySelector("b")!.textContent = document.title.replace(/ · HypePlay$/, "");
  const room = roomButton();
  b.append(room);
  document.body.append(b);
  // The same room from the game's panel (overlay.js): a button that presses this one and shows what it says.
  const mirror = document.createElement("button");
  mirror.type = "button";
  const sync = () => {
    mirror.textContent = room.textContent;
    mirror.disabled = room.disabled;
    b.classList.toggle("waiting", /esperando/.test(room.textContent ?? ""));
  };
  new MutationObserver(sync).observe(room, { childList: true, characterData: true, subtree: true, attributes: true });
  sync();
  mirror.addEventListener("click", () => room.click());
  (window as unknown as { hypeplayOverlay?: OverlayApi }).hypeplayOverlay?.online(
    "Abra uma sala: um amigo entra pela <b>biblioteca</b>, em <b>Entrar como jogador 2</b>, e joga com o controle dele; outros podem <b>Assistir</b>.",
    mirror,
  );
  if (open) room.click();
  // TabStationToo's settings, whose menus are hidden here, in the panel
  const overlay = (window as unknown as { hypeplayOverlay?: OverlayApi }).hypeplayOverlay;
  if (overlay) for (const [el, tab] of perfSections(overlay.reopen)) overlay.section(el, tab);
}

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open("pcsx2-web-cards", 1);
    // (the same stores TabStationToo makes, in case this runs first)
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("cards", { keyPath: "id" });
      db.createObjectStore("bytes");
      db.createObjectStore("meta");
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((ok, fail) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req ? req.result : undefined);
    t.onerror = () => fail(t.error);
  });
}

/** The unsent card waits in the emulator's database, so it outlives a closed page. */
function dirtyStore(db: IDBDatabase): CardStore {
  return {
    getDirty: async () => ((await tx<unknown>(db, "meta", "readonly", (m) => m.get(DIRTY_KEY))) as Uint8Array | undefined) ?? null,
    setDirty: async (b) => {
      await tx<unknown>(db, "meta", "readwrite", (m) => (b ? (m.put(b, DIRTY_KEY) as IDBRequest<unknown>) : (m.delete(DIRTY_KEY) as IDBRequest<unknown>)));
    },
  };
}

/** The person's card as TabStationToo's card in slot 1, before its app.js reads the library. */
async function seedCard(db: IDBDatabase, bytes: Uint8Array) {
  await new Promise<void>((ok, fail) => {
    const t = db.transaction(["cards", "bytes", "meta"], "readwrite");
    const now = Date.now();
    t.objectStore("cards").put({ id: CARD_ID, name: "HypePlay", created: now, used: now, handle: null, file: null, unlinked: false });
    t.objectStore("bytes").put(bytes, CARD_ID);
    t.objectStore("meta").put({ slots: [CARD_ID, null], last: [CARD_ID, null] }, "slots");
    t.oncomplete = () => ok();
    t.onerror = () => fail(t.error);
  });
}

/** When TabStationToo keeps a copy of the card (after each save of the game), it goes to the server too. */
function watchSaves(saved: (bytes: Uint8Array) => unknown) {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === "bytes" && key === CARD_ID && value instanceof Uint8Array && value.length === CARD_BYTES) void saved(value);
    return put.call(this, value, key);
  } as typeof put;
}

const holdPage = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "";
};

/** The card: the server's (or one left unsent here) into slot 1, and each save of the game back to the server. */
async function cards() {
  const locks = await navigator.locks?.query?.().catch(() => null);
  if (heldByOtherTab(locks ?? null)) return "other-tab" as const;
  const db = await idb();
  const sync = createCardSync({
    fetch: window.fetch.bind(window),
    store: dirtyStore(db),
    guard: (on) => (on ? addEventListener("beforeunload", holdPage) : removeEventListener("beforeunload", holdPage)),
  });
  const { seed, saving } = await sync.start();
  if (seed) await seedCard(db, seed);
  // (after seeding: the card that just came from the server doesn't go back up)
  if (saving) watchSaves((b) => sync.saved(b));
  return saving ? ("saving" as const) : ("offline" as const);
}

function loadApp() {
  const held = document.querySelector<HTMLScriptElement>("script[data-cp-app]");
  const src = held?.dataset.cpApp;
  if (!src) return note("Não deu para abrir o jogo", "A página do emulador mudou. Avise quem cuida do servidor.");
  const s = document.createElement("script");
  s.src = src;
  document.head.append(s);
}

async function start() {
  style();
  if (!crossOriginIsolated) {
    const framed = window.parent !== window;
    return note(
      "Este jogo abre no navegador",
      framed ? "O Discord não liberou nesta janela o modo que o emulador de PS2 precisa." : "Este navegador não liberou o modo que o emulador de PS2 precisa. Use um Chrome ou Edge atualizado.",
      framed ? { label: "Abrir no navegador", run: () => parent.postMessage({ t: "cordplay:open", path: location.pathname }, "*") } : undefined,
    );
  }
  // TabStationToo boots what ?bios= and ?disc= name (same origin): the server's BIOS and this game's disc.
  const q = new URLSearchParams(location.search);
  const openRoom = q.get("online") === "host";
  q.delete("online");
  q.set("bios", "../../../bios.bin");
  q.set("disc", "disc.iso");
  // The panel's "Avançado" (perf.ts), which the emulator reads only as it starts: what's saved now, never what an
  // earlier opening left in the address (a ?set= typed by hand goes too).
  for (const k of BOOT_PARAMS) q.delete(k);
  for (const [k, v] of bootParams(readBoot())) q.append(k, v);
  history.replaceState(null, "", `${location.pathname}?${q}`);
  let card: Awaited<ReturnType<typeof cards>> | "error" = "error";
  try {
    card = await cards();
  } catch (err) {
    console.warn("HypePlay: the memory card", err);
  }
  if (card === "other-tab")
    return note("Este jogo já está aberto em outra aba", "Os saves só ficam guardados em uma janela por vez. Feche a outra e abra o jogo de novo aqui.");
  if (document.readyState === "loading") await new Promise((ok) => document.addEventListener("DOMContentLoaded", ok, { once: true }));
  bar(openRoom);
  if (card !== "saving") warn("Não deu para buscar o seu save no servidor agora. Dá para jogar, mas o que você salvar nesta vez não vai para o servidor.");
  // (app.js names the tab after the disc and itself: the tab keeps the game's name and ours)
  const ours = document.title;
  new MutationObserver(() => {
    if (document.title !== ours) document.title = ours;
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  // What anyone has seen this game draw, made ahead of time (pipesync.ts): the library's id is the serial, in lower case
  // (another copy of the game: -2, -3… after it)
  const serial = /\/ps2\/([a-z]{4}-\d{5})(?:-\d{1,2})?\/game\//.exec(location.pathname)?.[1]?.toUpperCase();
  if (serial) await syncPipelines(serial).catch((err) => console.warn("HypePlay: the pipeline list", err));
  loadApp();
}

void start();

