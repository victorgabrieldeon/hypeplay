// The home with a controller, like a console's menu: the d-pad or the left stick moves the focus to the nearest thing
// that way (spatial.ts), ✕/A chooses, ○/B goes back (closes the drawer or a window), Start plays the game in focus.
// The pad is read through its map (the controller screen's), and nothing happens while that screen is open (its
// buttons are being mapped there). A legend of the buttons shows while the controller is in use. The right stick
// scrolls what's in front.
import { gameOf, hooks } from './app.js';

const { STANDARD, nearest, padFamily, remap, stickScroll, validMapping } = globalThis.CordPad;
const B = Object.fromEntries(STANDARD.map((name, i) => [name, i]));
const EVERY_MS = 30;
const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 110;

let maps = {};
const held = new Map(); // button or direction → when it went down (and its last repeat)
let lastBox = null; // where the focus was, for when its element is redrawn away

async function loadMaps() {
  try { const r = await fetch('pad', { cache: 'no-store' }); if (r.ok) maps = await r.json(); } catch (e) { /* the pad as it is */ }
}

function pad() {
  let pads;
  try { pads = [...navigator.getGamepads()].filter(Boolean); } catch (e) { return null; }
  const p = pads[0];
  if (!p) return null;
  return maps[p.id] && validMapping(maps[p.id]) ? remap(p, maps[p.id]) : p;
}

/** Where the focus can go now: the open window, else the open drawer, else the page. */
function scope() {
  const layer = document.getElementById('layer');
  if (layer.firstElementChild) return layer;
  const drawer = document.getElementById('drawer');
  return drawer.classList.contains('open') ? drawer : document.querySelector('.app');
}

/** What scrolls inside `root`: it or the first thing in it with more to show; the page when that's the page. */
function scroller(root) {
  const scrolls = (el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
  if (root.matches('.app')) return document.scrollingElement;
  if (scrolls(root)) return root;
  return [...root.querySelectorAll('*')].find(scrolls) ?? document.scrollingElement;
}

function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]), a[href], input:not([type=hidden]):not([type=file]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden]'); });
}

/** The focus, marked by a class of ours: :focus-visible depends on the window having the focus, which Discord's frame may not. */
function focus(el) {
  document.querySelector('.pad-focus')?.classList.remove('pad-focus');
  el.classList.add('pad-focus');
  el.focus({ preventScroll: true, focusVisible: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  lastBox = el.getBoundingClientRect();
}

function move(dir) {
  const root = scope();
  const all = focusables(root);
  if (!all.length) return;
  const marked = document.querySelector('.pad-focus');
  const active = marked && root.contains(marked) && marked.isConnected ? marked : document.activeElement;
  const cur = root.contains(active) && active !== document.body ? active : null;
  if (!cur) {
    // (nothing in focus yet: the main thing there, or what's nearest where the focus last was)
    const start = lastBox ? all[nearest(lastBox, all.map((el) => el.getBoundingClientRect()), dir)] : null;
    return focus(start ?? root.querySelector('.hero [data-play], .dialog button:not([aria-label]), [data-close]') ?? all[0]);
  }
  const i = nearest(cur.getBoundingClientRect(), all.map((el) => el.getBoundingClientRect()), dir);
  if (i >= 0) focus(all[i]);
}

function back() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function start() {
  const key = (document.querySelector('.pad-focus') ?? document.activeElement)?.closest?.('[data-open]')?.dataset.open;
  const g = key && gameOf(key);
  if (g && g.status.state === 'ready') return hooks.play(g);
  document.querySelector('.hero [data-play]')?.click();
}

function legend(p) {
  const xbox = padFamily(p.id ?? '') === 'xbox';
  document.getElementById('pad-hints').innerHTML = xbox
    ? '<span><i>A</i>Escolher</span><span><i>B</i>Voltar</span><span><i>Menu</i>Jogar</span>'
    : '<span><i>✕</i>Escolher</span><span><i>○</i>Voltar</span><span><i>Start</i>Jogar</span>';
}

/** True once per press, and again while held (after a pause, then quickly), like a console's menu. */
function pressed(name, down, now) {
  if (!down) { held.delete(name); return false; }
  const h = held.get(name);
  if (!h) { held.set(name, { at: now, last: now }); return true; }
  if (now - h.at < REPEAT_FIRST_MS || now - h.last < REPEAT_MS) return false;
  h.last = now;
  return true;
}

// Another window in front (the game opened in the browser, with the Activity still open in Discord): a controller is
// read by every window, so this one lets go until it's back in front.
let away = false;
addEventListener('blur', () => { away = true; held.clear(); });
addEventListener('focus', () => { away = false; });
addEventListener('pointerdown', () => { away = false; }, true);

function tick() {
  if (away || document.hidden) return;
  const p = pad();
  if (!p) return;
  const now = performance.now();
  const btn = (name) => !!p.buttons[B[name]]?.pressed;
  const [x = 0, y = 0] = p.axes;
  const dirs = { up: btn('up') || y < -0.5, down: btn('down') || y > 0.5, left: btn('left') || x < -0.5, right: btn('right') || x > 0.5 };
  const any = Object.values(dirs).some(Boolean) || ['cross', 'circle', 'start'].some(btn);
  // the controller screen maps raw buttons: hands off there
  if (document.querySelector('#layer [data-c]')) { held.clear(); return; }
  // the right stick scrolls what's in front: the open window, the drawer, or the page
  const by = stickScroll(p.axes[3] ?? 0, EVERY_MS);
  if (by) scroller(scope()).scrollBy({ top: by, behavior: 'instant' });
  if (any && !document.documentElement.classList.contains('pad-mode')) {
    document.documentElement.classList.add('pad-mode');
    legend(p);
  }
  // the intro: any button goes on to the game
  const intro = document.querySelector('.intro');
  if (intro) {
    if (pressed('cross', btn('cross'), now) || pressed('circle', btn('circle'), now) || pressed('start', btn('start'), now)) intro.click();
    return;
  }
  for (const [dir, down] of Object.entries(dirs)) if (pressed(dir, down, now)) move(dir);
  if (pressed('cross', btn('cross'), now)) {
    const marked = document.querySelector('.pad-focus');
    const el = marked && scope().contains(marked) ? marked : document.activeElement;
    if (el && el !== document.body) el.click();
    else move('down');
  }
  if (pressed('circle', btn('circle'), now)) back();
  if (pressed('start', btn('start'), now)) start();
}

// the mouse takes over again: the console look goes
for (const t of ['mousemove', 'mousedown'])
  addEventListener(t, () => {
    document.documentElement.classList.remove('pad-mode');
    document.querySelector('.pad-focus')?.classList.remove('pad-focus');
  }, { passive: true });
addEventListener('gamepadconnected', loadMaps);
loadMaps();
setInterval(tick, EVERY_MS);
