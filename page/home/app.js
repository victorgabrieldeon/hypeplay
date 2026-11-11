// The home's state and wiring: follows home/ws (feed.js: the server pushes what changed), reading `games` every 2 s
// only while that socket is down, draws the spotlight, the library and the open drawer, and handles every button
// (play, send a disc or the BIOS, remove, rename, cover). The add-a-game wizard, the controller screen and the intro
// live in their own modules.
import { ask } from './ask.js';
import { drawer } from './drawer.js';
import { follow, merge } from './feed.js';
import { addCard, arrange, card, esc, hero, icon, initials, installCard, installing, meter, needsDisc, paintInstall, sendBios, upload } from './library.js';

const $ = (id) => document.getElementById(id);

export const state = {
  me: '',
  last: null,
  publicUrl: '',
  games: null,
  /** who else is around (server/presence.ts): the same call first */
  people: [],
  /** friends, requests, invites and the friends' activity (server/social.ts; home/friends.js draws them) */
  social: null,
  /** the drawer's game, by key */
  open: null,
  /** this window's upload: { key, size, received, inflight, meter, retrying } */
  sending: null,
  uploadError: { key: null, text: '' },
  /** someone else's upload, seen through the pushes (or the polls): its speed per game */
  watching: new Map(),
  /** the vimm.net download (server/vimm.ts), pushed by vimm/ws: GET vimm's shape */
  vimm: null,
  expired: false,
};

export const gameOf = (key) => state.games?.find((g) => g.key === key);

/** Only touches the page where something changed: keeps focus and hover where they are between polls. */
export function set(el, html) {
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

/** One person around: what they have open, and their PS2 room (to join as player 2 while the place is free, or watch). */
export function person(p, extra = '', name = esc(p.name)) {
  const room = p.room && gameOf(p.room.key) ? p.room : null;
  const title = p.game?.title ?? (room && gameOf(room.key).name);
  const doing = p.game?.watch ? `Assistindo ${title}` : title ? `Jogando ${title}` : 'Na biblioteca';
  const about = room ? `${room.busy ? 'Jogador 2 ocupado' : 'Vaga de jogador 2'}${room.watchers ? ` · ${room.watchers} assistindo` : ''}` : '';
  const join = (label, cls, watch) =>
    `<button class="btn ${cls} small" data-play="${esc(room.key)}" data-join="${esc(room.code)}"${watch ? ' data-watch' : ''} aria-label="${esc(`${label} na sala de ${p.name}`)}">${icon(watch ? 'play' : 'users')}${label}</button>`;
  const acts = room ? `<div class="acts">${room.busy ? '' : join('Entrar', '', false)}${join('Assistir', 'second', true)}</div>` : '';
  return `<div class="person"><div class="avatar" aria-hidden="true">${esc(initials(p.name))}</div>
    <div class="who"><b>${name}${p.call ? '<span class="tag">NA CALL</span>' : ''}</b>
      <span class="state ${title ? 'ok live' : ''}">${esc(doing)}</span>${about ? `<small>${esc(about)}</small>` : ''}</div>${acts}${extra}</div>`;
}

function renderPeople() {
  const ps = state.people;
  const inCall = ps.filter((p) => p.call).length;
  $('people').hidden = !ps.length;
  document.querySelector('[data-nav="people"]').hidden = !ps.length;
  set($('n-people'), ps.length ? String(ps.length) : '');
  set($('people-sub'), [inCall && `${inCall} na sua call`, ps.length - inCall && `${ps.length - inCall} ${inCall ? 'fora dela' : 'online'}`].filter(Boolean).join(' · '));
  set($('people-list'), ps.map(person).join(''));
}

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
  // (a short window shows two rows: one big cover there, or the bigs would be all of it)
  const wall = arrange(state.games, top, state.sending, matchMedia('(max-height: 620px)').matches ? 1 : 3);
  const cards = wall.map(({ g, big }, i) => card(g, state.sending, state.open, i, big));
  // (the game on its way from vimm.net: right after the big ones)
  if (installing(state.vimm)) { const at = wall.filter((x) => x.big).length; cards.splice(at, 0, installCard(state.vimm, at)); }
  set($('grid'), cards.join('') + addCard(n));
  paintInstall(state.vimm);
  hooks.people();
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

/** Someone else's upload: its speed, from what each look says it has received. */
function watchUploads() {
  for (const g of state.games ?? []) {
    const s = g.status;
    if (s.state === 'uploading' && !s.mine && !s.stale) {
      // The server takes 32 MB at a time: a minute of history smooths that out.
      if (!state.watching.has(g.key)) state.watching.set(g.key, meter(60_000));
      state.watching.get(g.key).add(s.received);
    } else state.watching.delete(g.key);
  }
}

/** The home as the feed pushed it (feed.js): only what changed. */
function pushed(m) {
  merge(state, m);
  // (the poll's tag is of a home before these: the next poll gets the whole of it)
  tag = null;
  watchUploads();
  render();
}

/**
 * The version of the home the poll last read (its ETag): the server answers 304 while it's the same. Sent as `?v=`:
 * If-None-Match would cost a preflight on every poll from this opaque origin.
 */
let tag = null;

/** A fresh look at the home: asked on the socket while it's open, else read from `games`. */
export async function poll() {
  if (await feed?.sync()) return;
  try {
    const r = await fetch(tag ? `games?v=${encodeURIComponent(tag)}` : 'games', { cache: 'no-store' });
    if (r.status === 403) { state.expired = true; render(); return; }
    // (the socket came back meanwhile: what it pushes is newer than this)
    if (feed?.live) return;
    if (r.status !== 304) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.json();
      Object.assign(state, { me: body.me, last: body.last, publicUrl: body.publicUrl, games: body.games, people: body.people ?? [], social: body.social ?? null });
      tag = r.headers.get('etag');
      watchUploads();
    }
  } catch (e) {
    // (no connection for a moment: the next look tries again)
  }
  render();
}

/** Sends a disc image for a game already in the library (a PS2 game whose upload stopped). */
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
 * Where a game opens: a PS2 game's player 2 watches the host's stream (watch/); `join` is a friend's room (`watch`:
 * only to watch it), `online` opens one; else the game itself.
 */
export function gameUrl(g, join, online, fast, watch) {
  if (join) return `${g.key}/watch/?room=${encodeURIComponent(join)}${watch ? '&watch=1' : ''}`;
  // (a PS2 game's "versão rápida": the same rooms as the emulator's, opened from its panel)
  if (fast) return `${g.key}/fast/${online ? '?online=host' : ''}`;
  return `${g.key}/game/${online ? '?online=host' : ''}`;
}

/** A PS2 game's "versão rápida" plays (or the one before, while a new one builds): the library's buttons open it. */
export const fastPlays = (g) => !!g.fast && (g.fast.state === 'ready' || !!g.fast.playable);

/** Opens a game: the intro (intro.js, when it's there) first. Replaced by intro.js's own when loaded. */
export const hooks = {
  play: (g, join, online, fast, watch) => { location.href = gameUrl(g, join, online, fast, watch); },
  add: () => {},
  controller: () => {},
  settings: () => {},
  /** "Pessoas" in the words' column; friends.js draws its "Amigos" there once loaded */
  people: () => renderPeople(),
};

/** The wall's columns: as many whole covers as fit beside the words; what's left of the width goes to the words. */
function fit() {
  const tw = $('probe').getBoundingClientRect().width;
  const width = document.documentElement.clientWidth;
  if (!tw || width <= 760) return document.documentElement.style.removeProperty('--cols'); // (phones: three, in the CSS)
  document.documentElement.style.setProperty('--cols', String(Math.max(2, Math.floor((width - 280 + 2) / (tw + 2)))));
}
addEventListener('resize', fit);
fit();

/** The cover clicked on the wall (`from`: its place and image, read before the wall is redrawn) grows into the drawer's poster while the drawer slides in. */
function fly(from) {
  const drawer = $('drawer');
  const to = drawer.querySelector('.poster img');
  if (!from || !to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = from.rect, d = drawer.getBoundingClientRect(), p = to.getBoundingClientRect();
  // (the drawer is still off the screen: the poster's place once it's in)
  const end = { left: document.documentElement.clientWidth - d.width + (p.left - d.left), top: p.top, width: p.width, height: p.height };
  const img = Object.assign(document.createElement('img'), { src: from.src, className: 'flying', alt: '' });
  const box = (r) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(img);
  to.style.opacity = '0';
  const run = img.animate([box(a), box(end)], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  run.onfinish = run.oncancel = () => { to.style.opacity = ''; img.remove(); };
}

let lastFocus = null;
export function openDrawer(key, from) {
  if (!gameOf(key)) return;
  if (state.open !== key) lastFocus = document.activeElement;
  const opening = !$('drawer').classList.contains('open');
  // (the clicked cover is redrawn by render, marked as the drawer's: where it was is read now)
  const start = from && { rect: from.getBoundingClientRect(), src: from.currentSrc || from.src };
  state.open = key;
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  render();
  if (opening) fly(start);
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
  const el = e.target.closest('[data-open],[data-play],[data-pick],[data-bios],[data-fast-build],[data-fast-remove],[data-remove],[data-cover],[data-cover-remove],[data-close],[data-add],[data-controller],[data-settings],[data-nav]');
  if (!el) {
    if (e.target === $('scrim')) closeDrawer();
    return;
  }
  const d = el.dataset;
  if ('close' in d) return closeDrawer();
  if ('add' in d) return hooks.add();
  if ('controller' in d) return hooks.controller();
  if ('settings' in d) return hooks.settings();
  if (d.nav) {
    for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('on', b === el);
    return document.getElementById(d.nav)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  if (d.open) return openDrawer(d.open, el.querySelector('img'));
  // (player 2 watches the host's page, whichever it is; data-emulator: the drawer's "Jogar no emulador")
  if (d.play) { const g = gameOf(d.play); if (g) hooks.play(g, d.join, 'online' in d, !d.join && !('emulator' in d) && fastPlays(g), 'watch' in d); return; }
  if (d.pick) return pickFile(d.pick, 'disc');
  if (d.cover) return pickFile(d.cover, 'cover');
  if ('bios' in d) return pickFile(state.open, 'bios');
  el.disabled = true;
  if (d.fastBuild) {
    // (refused with a reason, say the limit per person: shown in the drawer like an upload's)
    const r = await api(`${d.fastBuild}/fast-build`, { method: 'POST' }).catch(() => null);
    const error = r && !r.ok ? (await r.json().catch(() => null))?.error : '';
    state.uploadError = { key: d.fastBuild, text: error || '' };
  }
  if (d.fastRemove && await ask({ title: 'Apagar a versão rápida?', text: 'Some para todo mundo. O jogo continua no emulador, e os saves ficam.', ok: 'Apagar', danger: true }))
    await api(`${d.fastRemove}/fast-build`, { method: 'DELETE' });
  if (d.coverRemove) await api(`${d.coverRemove}/cover`, { method: 'DELETE' });
  if (d.remove) {
    const g = gameOf(d.remove);
    if (g && await ask({ title: `Remover ${g.name}?`, text: 'Sai da biblioteca para todo mundo e a ISO é apagada do servidor. Os saves ficam guardados.', ok: 'Remover', danger: true })) {
      const r = await api(d.remove, { method: 'DELETE' }).catch(() => null);
      if (r?.ok) {
        // (off the screen now, not on the next look)
        state.games = state.games.filter((x) => x.key !== g.key);
        closeDrawer();
        render();
      } else await ask({ title: 'Não deu para remover', text: `O servidor não removeu ${g.name}${r ? ` (HTTP ${r.status})` : ''}. Tente de novo.`, cancel: null });
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

/** The vimm.net download as it goes: redrawn when its step changes, else only its pie; the loja and the wizard get a 'vimm' event. */
function watchVimm(wait = 1000) {
  const ws = new WebSocket(new URL('vimm/ws', location.href).href.replace(/^http/, 'ws'));
  ws.onmessage = (e) => {
    const v = JSON.parse(e.data);
    const was = state.vimm?.state;
    state.vimm = v;
    wait = 1000;
    if (v.state !== was) render();
    else paintInstall(v);
    const tell = () => dispatchEvent(new CustomEvent('vimm', { detail: v }));
    // (the game is in the library now: told once the library has it, for the wizard's "Jogar")
    if (v.state === 'done' && was && was !== 'done') poll().then(tell);
    else tell();
  };
  ws.onclose = () => { if (!state.expired) setTimeout(() => watchVimm(Math.min(wait * 2, 30_000)), wait); };
}

// The feed; while it's down, the poll every 2 s (and, with it, every 2 s a redraw: "há 3 min" and the greeting move on).
let feed = null;
feed = follow(new URL('home/ws', location.href).href.replace(/^http/, 'ws'), { apply: pushed, down: () => poll(), again: () => !state.expired });
// (the first look read at once, without waiting for the socket: what it pushes replaces it)
poll();
setInterval(() => { if (!state.expired) feed.live ? render() : poll(); }, 2000);
watchVimm();
// The add-a-game wizard, the controller screen and the intro set their hooks once loaded.
for (const m of ['./wizard.js', './controller.js', './settings.js', './store.js', './intro.js', './gamepadnav.js', './friends.js']) import(m).catch((e) => console.warn('home:', m, e));
