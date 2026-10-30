import { createCardSync, heldByOtherTab, type CardStore } from "./cardsync";
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
/** A card the server hasn't got yet (cardsync.ts), in the emulator's own database. */
const DIRTY_KEY = "cordplay-unsent";

const STYLE = `
@font-face { font-family: "Inter"; font-weight: 100 900; font-display: swap; src: url("../../../fonts/inter-latin-wght-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-weight: 300 700; font-display: swap; src: url("../../../fonts/space-grotesk-latin-wght-normal.woff2") format("woff2"); }
html, body { background: #0b0a14 !important; overflow: hidden !important; }
body > * { visibility: hidden !important; }
#screen, #screen *, #slate, #slate *, #cp-bar, #cp-bar *, #cp-license, #cp-license *, #cp-ov, #cp-ov *, #cp-crt, #cp-note, #cp-note * { visibility: visible !important; }
#screen { position: fixed !important; inset: 0 !important; z-index: 10 !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important;
  background: #000 !important; display: grid !important; place-items: center !important; width: auto !important; height: auto !important; transform: none !important; }
#screen canvas { width: 100% !important; height: 100% !important; object-fit: contain !important; max-width: none !important; max-height: none !important; }
#slate { position: fixed !important; left: 50% !important; bottom: 32px !important; top: auto !important; transform: translateX(-50%) !important; z-index: 20 !important;
  width: min(460px, calc(100% - 32px)) !important; background: rgb(15 13 26 / 0.94) !important; color: #f3f2fb !important; border-radius: 18px !important;
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.08) !important; padding: 16px 20px !important;
  font: 400 15px/24px Inter, ui-sans-serif, system-ui, sans-serif !important; text-align: center; }
#slate[hidden] { display: none !important; }
#slate h1, #slate h2 { font: 600 17px/26px "Space Grotesk", ui-sans-serif, system-ui, sans-serif !important; color: #f3f2fb !important; margin: 0 0 4px !important; }
#slate p, #slate .fine { color: #a3a1bd !important; }
#slate button { font: 600 14px/1 Inter, ui-sans-serif, system-ui, sans-serif !important; border: 0 !important; border-radius: 8px !important; height: 36px; padding: 0 14px;
  background: #242040 !important; color: #f3f2fb !important; cursor: pointer; }
#slate .btn-primary { background: #7655ff !important; color: #fff !important; }
#slate .cmd, #slate #dev-copy, #slate #slate-library, #slate #slate-disc, #slate #slate-remove { display: none !important; }
#cp-bar { position: fixed; top: 10px; left: 10px; z-index: 2147483646; display: flex; align-items: center; gap: 8px; padding: 4px;
  border-radius: 12px; background: rgb(15 13 26 / 0.72); backdrop-filter: blur(8px); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
  font: 600 13px/20px Inter, ui-sans-serif, system-ui, sans-serif; color: #f3f2fb; opacity: 0.25; transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1); }
#cp-bar:hover, #cp-bar:focus-within, #cp-bar.near { opacity: 1; }
#cp-bar a, #cp-bar button { display: inline-flex; align-items: center; height: 30px; padding: 0 10px; border: 0; border-radius: 8px; background: #242040;
  color: inherit; text-decoration: none; font: inherit; cursor: pointer; }
#cp-bar a:hover, #cp-bar button:hover { background: #2c2750; }
#cp-bar a:focus-visible, #cp-bar button:focus-visible { outline: 2px solid #a08cff; outline-offset: 2px; }
#cp-bar b { font: 600 14px/20px "Space Grotesk", ui-sans-serif, system-ui, sans-serif; padding: 0 6px; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cp-license { position: fixed; right: 12px; bottom: 6px; z-index: 30; margin: 0; font: 400 11px/16px Inter, ui-sans-serif, system-ui, sans-serif; color: #6f6c8c; }
#cp-license a { color: #a3a1bd; }
#cp-note { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: #0b0a14;
  font: 400 15px/24px Inter, ui-sans-serif, system-ui, sans-serif; color: #f3f2fb; text-align: center; }
#cp-note > div { max-width: 460px; display: flex; flex-direction: column; gap: 12px; align-items: center; }
#cp-note h1 { font: 600 22px/28px "Space Grotesk", ui-sans-serif, system-ui, sans-serif; margin: 0; }
#cp-note p { color: #a3a1bd; margin: 0; }
#cp-note button, #cp-note a { height: 40px; padding: 0 16px; border: 0; border-radius: 8px; background: #7655ff; color: #fff; font: 600 15px/40px Inter, sans-serif;
  cursor: pointer; text-decoration: none; }
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
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483646;margin:0;max-width:min(560px,calc(100% - 32px));padding:10px 14px;border-radius:12px;background:rgb(15 13 26 / .94);color:#f5a524;font:400 13px/20px Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 0 0 1px rgb(255 255 255 / .08);visibility:visible";
  document.body.append(n);
  setTimeout(() => n.remove(), 12_000);
}

function bar() {
  const b = document.createElement("div");
  b.id = "cp-bar";
  b.innerHTML = '<a href="../../../" aria-label="Voltar para a biblioteca">← Biblioteca</a><b></b>';
  b.querySelector("b")!.textContent = document.title.replace(/ · CordPlay$/, "");
  b.append(roomButton());
  document.body.append(b);
  document.addEventListener("pointermove", (e) => b.classList.toggle("near", e.clientX < 320 && e.clientY < 90), { passive: true });
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
    t.objectStore("cards").put({ id: CARD_ID, name: "CordPlay", created: now, used: now, handle: null, file: null, unlinked: false });
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
  q.set("bios", "../../../bios.bin");
  q.set("disc", "disc.iso");
  history.replaceState(null, "", `${location.pathname}?${q}`);
  let card: Awaited<ReturnType<typeof cards>> | "error" = "error";
  try {
    card = await cards();
  } catch (err) {
    console.warn("CordPlay: the memory card", err);
  }
  if (card === "other-tab")
    return note("Este jogo já está aberto em outra aba", "Os saves só ficam guardados em uma janela por vez. Feche a outra e abra o jogo de novo aqui.");
  if (document.readyState === "loading") await new Promise((ok) => document.addEventListener("DOMContentLoaded", ok, { once: true }));
  bar();
  if (card !== "saving") warn("Não deu para buscar o seu save no servidor agora. Dá para jogar, mas o que você salvar nesta vez não vai para o servidor.");
  // (app.js names the tab after the disc and itself: the tab keeps the game's name and ours)
  const ours = document.title;
  new MutationObserver(() => {
    if (document.title !== ours) document.title = ours;
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  loadApp();
}

void start();

