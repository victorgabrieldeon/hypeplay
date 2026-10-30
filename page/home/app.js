// The home's state and wiring: reads `games` every 2 s, draws the spotlight, the library and the open drawer, and
// handles every button (play, send a disc or the BIOS, retry, remove, rename, cover). The add-a-game wizard, the
// controller screen and the intro live in their own modules.
import { drawer } from './drawer.js';
import { loadHomebrew } from './homebrew.js';
import { addCard, card, esc, hero, initials, meter, needsDisc, sendBios, upload } from './library.js';

const $ = (id) => document.getElementById(id);

export const state = {
  me: '',
  last: null,
  publicUrl: '',
  games: null,
  /** the drawer's game, by key */
  open: null,
  /** this window's upload: { key, size, received, inflight, meter, retrying } */
  sending: null,
  uploadError: { key: null, text: '' },
  /** someone else's upload, seen through the polls: its speed per game */
  watching: new Map(),
  expired: false,
};

export const gameOf = (key) => state.games?.find((g) => g.key === key);

/** Only touches the page where something changed: keeps focus and hover where they are between polls. */
function set(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

/** The spotlight: the person's last game, else the first one ready, else the first one. */
function spotlight() {
  const gs = state.games;
  return gs.find((g) => g.key === state.last) ?? gs.find((g) => g.status.state === 'ready') ?? gs[0];
}

const greeting = (h) => (h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite');

let entered = false;
export function render() {
  $('expired').hidden = !state.expired;
  if (!state.games) return;
  // The first look only: the spotlight and the cards come in one after another (later polls just swap them).
  if (!entered) {
    entered = true;
    document.body.classList.add('entering');
    setTimeout(() => document.body.classList.remove('entering'), 1600);
  }
  set($('me'), state.me ? `<span>${esc(state.me)}</span><div class="avatar" aria-hidden="true">${esc(initials(state.me))}</div>` : '');
  set($('hello'), esc(greeting(new Date().getHours()) + (state.me ? ', ' + state.me.split(/\s+/)[0] : '')));
  const n = state.games.length;
  const rooms = state.games.reduce((sum, g) => sum + g.open.length, 0);
  set($('sub'), `${n} ${n === 1 ? 'jogo' : 'jogos'} no servidor, prontos para a call${rooms ? ` <span class="state ok live">${rooms} ${rooms === 1 ? 'sala aberta' : 'salas abertas'} agora</span>` : ''}`);
  set($('n-games'), String(n));
  const top = spotlight();
  $('hero').hidden = !top;
  if (top) {
    set($('hero'), hero(top, state.sending, top.key === state.last ? 'Continuar jogando' : 'Em destaque'));
    $('hero').classList.remove('loading');
    $('hero').removeAttribute('aria-busy');
  }
  set($('grid'), state.games.map((g, i) => card(g, state.sending, state.open, i)).join('') + addCard(n));
  const g = state.open && gameOf(state.open);
  if (state.open && !g) closeDrawer(); // removed meanwhile
  else if (g) {
    $('drawer-title').textContent = g.name;
    // (the name being typed isn't redrawn under the cursor)
    if (document.activeElement?.id !== 'game-name') set($('drawer-body'), drawer(g, state));
  }
}

// Progress events come many times a second: one render per quarter second is enough.
let later = 0;
export function soon() {
  if (!later) later = setTimeout(() => { later = 0; render(); }, 250);
}

export async function poll() {
  try {
    const r = await fetch('games', { cache: 'no-store' });
    if (r.status === 403) { state.expired = true; render(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.json();
    Object.assign(state, { me: body.me, last: body.last, publicUrl: body.publicUrl, games: body.games });
    for (const g of state.games) {
      const s = g.status;
      if (s.state === 'uploading' && !s.mine && !s.stale) {
        // The server takes 32 MB at a time: a minute of history smooths that out.
        if (!state.watching.has(g.key)) state.watching.set(g.key, meter(60_000));
        state.watching.get(g.key).add(s.received);
      } else state.watching.delete(g.key);
    }
  } catch (e) {
    // (no connection for a moment: the next look tries again)
  }
  render();
}

/** Sends a disc image for a game already in the library (BT3, or a PS2 game whose upload stopped). */
export async function send(key, file) {
  const g = gameOf(key);
  state.uploadError = { key, text: '' };
  if (!g || state.sending) return;
  if (file.size < g.minIso || file.size > g.maxIso) {
    state.uploadError.text = 'Esse arquivo não parece a ISO do jogo (tamanho fora do esperado).';
    return render();
  }
  try {
    await upload(key, file, {
      start: (s) => { state.sending = s; openDrawer(key); },
      changed: (often) => (often ? soon() : render()),
      expired: () => { state.expired = true; },
      error: (text) => { state.uploadError.text = text; },
    });
  } finally {
    state.sending = null;
    await poll();
  }
}

/**
 * Where a game opens: a PS2 game's player 2 watches the host's stream (watch/); `join` is a friend's room, `online`
 * opens one (for BT3's port, both point the way to its own Dragon Net Battle); else the game itself.
 */
export function gameUrl(g, join, online) {
  if (join && g.kind === 'recomp') return `${g.key}/watch/?room=${encodeURIComponent(join)}`;
  return `${g.key}/game/${join ? `?join=${encodeURIComponent(join)}` : online ? '?online=host' : ''}`;
}

/** Opens a game: the intro (intro.js, when it's there) first. Replaced by intro.js's own when loaded. */
export const hooks = {
  play: (g, join, online) => { location.href = gameUrl(g, join, online); },
  add: () => {},
  controller: () => {},
};

let lastFocus = null;
export function openDrawer(key) {
  if (!gameOf(key)) return;
  if (state.open !== key) lastFocus = document.activeElement;
  state.open = key;
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  render();
  $('drawer').querySelector('[data-close]').focus({ preventScroll: true });
}

export function closeDrawer() {
  state.open = null;
  $('drawer').classList.remove('open');
  $('scrim').classList.remove('open');
  lastFocus?.focus?.({ preventScroll: true });
  render();
}

const api = (path, init) => fetch(path, init).then((r) => { if (r.status === 403) state.expired = true; return r; });

let picking = null; // what the file picker is for: { key, kind: 'disc' | 'cover' | 'bios' }
function pickFile(key, kind) {
  picking = { key, kind };
  const input = $('file');
  input.accept = kind === 'cover' ? 'image/png,image/jpeg,image/webp' : kind === 'bios' ? '.bin,.rom0,.ROM0,application/octet-stream' : '.iso,.bin,.img';
  input.click();
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !picking) return;
  const { key, kind } = picking;
  picking = null;
  if (kind === 'disc') return send(key, file);
  if (kind === 'bios') {
    state.uploadError = { key, text: await sendBios(file) };
    return poll();
  }
  const r = await api(`${key}/cover`, { method: 'PUT', body: file });
  state.uploadError = { key, text: r.ok ? '' : ((await r.json().catch(() => ({}))).error ?? `Erro ${r.status}`) };
  await poll();
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-open],[data-play],[data-pick],[data-bios],[data-retry],[data-remove],[data-cover],[data-cover-remove],[data-close],[data-add],[data-controller],[data-nav]');
  if (!el) {
    if (e.target === $('scrim')) closeDrawer();
    return;
  }
  const d = el.dataset;
  if ('close' in d) return closeDrawer();
  if ('add' in d) return hooks.add();
  if ('controller' in d) return hooks.controller();
  if (d.nav) {
    for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('on', b === el);
    return document.getElementById(d.nav)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  if (d.open) return openDrawer(d.open);
  if (d.play) { const g = gameOf(d.play); if (g) hooks.play(g, d.join, 'online' in d); return; }
  if (d.pick) return pickFile(d.pick, 'disc');
  if (d.cover) return pickFile(d.cover, 'cover');
  if ('bios' in d) return pickFile(state.open, 'bios');
  el.disabled = true;
  if (d.retry) await api(`${d.retry}/retry`, { method: 'POST' });
  if (d.coverRemove) await api(`${d.coverRemove}/cover`, { method: 'DELETE' });
  if (d.remove) {
    const g = gameOf(d.remove);
    if (g && confirm(`Remover "${g.name}" para todo mundo? Os saves ficam guardados.`)) {
      await api(d.remove, { method: 'DELETE' });
      closeDrawer();
    }
  }
  el.disabled = false;
  await poll();
});

// Renaming: saved on Enter or when the field loses focus.
async function rename(input) {
  const key = input.dataset.rename;
  const g = gameOf(key);
  const name = input.value.trim();
  if (!g || name === g.name) return;
  await api(key, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  await poll();
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('[data-rename]') && e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape' && state.open && !document.querySelector('#layer > *')) closeDrawer();
});
document.addEventListener('focusout', (e) => { if (e.target.matches?.('[data-rename]')) rename(e.target); });

// Dropping a disc image on a drop box (anywhere else, a dropped file would open in place of the page).
const dropOf = (e) => e.target.closest?.('[data-drop]');
document.addEventListener('dragover', (e) => { e.preventDefault(); dropOf(e)?.classList.add('over'); });
document.addEventListener('dragleave', (e) => dropOf(e)?.classList.remove('over'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const d = dropOf(e);
  if (!d) return;
  d.classList.remove('over');
  const file = e.dataTransfer.files[0];
  const g = gameOf(d.dataset.drop);
  if (file && g && needsDisc(g, state.sending)) send(g.key, file);
});

poll();
loadHomebrew(() => state.expired);
setInterval(() => { if (!state.expired) poll(); }, 2000);
// The add-a-game wizard, the controller screen and the intro set their hooks once loaded.
for (const m of ['./wizard.js', './controller.js', './intro.js']) import(m).catch((e) => console.warn('home:', m, e));
