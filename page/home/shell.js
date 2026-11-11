// The frame around the library (DESIGN.md "Barra lateral" and "Destaque"): the banner that turns through a few games,
// the library's filters, search and grid/list switch, the side column's server state and "Jogar agora", and the bell. app.js calls hooks.shell(top) after each render.
import { hooks, isFavorite, render, set, state } from './app.js';
import { esc, hero, stateOf } from './library.js';

const $ = (id) => document.getElementById(id);
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- the banner: the spotlight, then games with an open room, the favorites and other ready ones (5 at most) ----

let slide = 0;
let slides = [];
let top = null;

function featured() {
  const gs = state.games ?? [];
  const ready = (g) => g.status.state === 'ready';
  const picks = [top, ...gs.filter((g) => g.open.length), ...gs.filter((g) => isFavorite(g.key) && ready(g)), ...gs.filter(ready)];
  return [...new Set(picks.filter(Boolean))].slice(0, 5);
}

function banner() {
  const el = $('banner');
  slides = featured();
  el.hidden = !slides.length;
  if (!slides.length) return;
  slide = Math.min(slide, slides.length - 1);
  const g = slides[slide];
  const label = g.key === state.last ? 'Continuar jogando' : g.open.length ? 'Sala aberta agora' : 'Em destaque';
  const many = slides.length > 1;
  set(el, `<img class="bg" src="${esc(g.cover)}" alt=""><img class="art" src="${esc(g.cover)}" alt="">
    <div class="hero">${hero(g, state.sending, label, isFavorite(g.key))}</div>
    ${many ? `<button type="button" class="arrow prev" data-slide="-1" aria-label="Destaque anterior"><svg class="i"><use href="#i-left"/></svg></button>
      <button type="button" class="arrow next" data-slide="1" aria-label="Próximo destaque"><svg class="i"><use href="#i-right"/></svg></button>
      <div class="dots">${slides.map((s, i) => `<button type="button" data-dot="${i}" class="${i === slide ? 'on' : ''}" aria-label="${esc(s.name)}"${i === slide ? ' aria-current="true"' : ''}></button>`).join('')}</div>` : ''}`);
  el.classList.remove('loading');
  el.removeAttribute('aria-busy');
}

function go(i) {
  if (!slides.length) return;
  slide = (i + slides.length) % slides.length;
  banner();
}

// (turns every 8 s, only while nobody is pointing at it or in it, and never with reduced motion)
let held = false;
setInterval(() => { if (!held && !still() && !document.hidden && slides.length > 1) go(slide + 1); }, 8000);
const b = $('banner');
b.addEventListener('pointerenter', () => { held = true; });
b.addEventListener('pointerleave', () => { held = false; });
b.addEventListener('focusin', () => { held = true; });
b.addEventListener('focusout', () => { held = false; });
b.addEventListener('click', (e) => {
  const el = e.target.closest('[data-slide],[data-dot]');
  if (!el) return;
  go(el.dataset.dot != null ? Number(el.dataset.dot) : slide + Number(el.dataset.slide));
});

// ---- the library's filters, search and view ----

const FILTERS = [
  ['all', 'Todos', () => true],
  ['ready', 'Prontos', (g) => g.status.state === 'ready'],
  ['fav', 'Favoritos', (g) => isFavorite(g.key)],
  ['rooms', 'Com sala aberta', (g) => g.open.length > 0],
  ['needs', 'Precisam de você', (g) => stateOf(g, state.sending)[0] !== 'ok'],
];
let filter = 'all';
let query = '';
let view = 'grid';
try { view = localStorage.getItem('hp-view') === 'list' ? 'list' : 'grid'; } catch (e) { /* no storage here */ }

const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function library() {
  const gs = state.games ?? [];
  const counts = FILTERS.map(([id, name, test]) => [id, name, gs.filter(test).length]);
  if (!counts.find(([id, , n]) => id === filter && (n || id === 'all'))) filter = 'all';
  set($('filters'), counts.filter(([id, , n]) => id === 'all' || n).map(([id, name, n]) =>
    `<button type="button" class="pill${id === filter ? ' on' : ''}" data-filter="${id}" aria-pressed="${id === filter}">${name} <span class="num">(${n})</span></button>`).join(''));
  const test = FILTERS.find(([id]) => id === filter)[2];
  const q = plain(query.trim());
  let shown = 0;
  for (const card of $('grid').children) {
    const key = card.querySelector('[data-open]')?.dataset.open;
    const g = key && gs.find((x) => x.key === key);
    // (the add card and a download on its way: only on "Todos", without a search)
    const on = g ? test(g) && (!q || plain(g.name).includes(q)) : filter === 'all' && !q;
    card.hidden = !on;
    if (on && g) shown++;
  }
  const empty = $('lib-empty');
  empty.hidden = !!shown || !gs.length;
  if (!empty.hidden) empty.textContent = q ? `Nenhum jogo com “${query.trim()}”.` : 'Nenhum jogo neste filtro.';
  $('grid').classList.toggle('as-list', view === 'list');
  for (const v of document.querySelectorAll('[data-view]')) {
    v.classList.toggle('on', v.dataset.view === view);
    v.setAttribute('aria-pressed', String(v.dataset.view === view));
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-filter],[data-view],[data-bell]');
  if (!el) return;
  const d = el.dataset;
  if (d.filter) { filter = d.filter; return library(); }
  if (d.view) {
    view = d.view;
    try { localStorage.setItem('hp-view', view); } catch (err) { /* no storage here */ }
    return library();
  }
  if ('bell' in d) { location.hash = 'amigos'; return; }
});
const input = $('search').querySelector('input');
input.addEventListener('input', () => {
  query = input.value;
  library();
  if (query) document.getElementById('lib-head').scrollIntoView({ block: 'nearest' });
});
input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; query = ''; library(); input.blur(); } });

// ---- the side column and the bell ----

function sync() {
  const s = state.social;
  const bell = document.querySelector('[data-bell]');
  bell.hidden = !s;
  const n = s ? s.invites.length + s.incoming.length : 0;
  bell.classList.toggle('dot', n > 0);
  bell.setAttribute('aria-label', n ? `${n} ${n === 1 ? 'aviso' : 'avisos'}: convites e pedidos de amizade` : 'Avisos');
  const play = $('play-now');
  const g = top?.status.state === 'ready' ? top : null;
  play.hidden = !g;
  if (g) { play.dataset.play = g.key; play.title = `Jogar ${g.name}`; }
}

// ---- the server: up and how far, a small public answer (/health) timed every 15 s ----

async function ping() {
  const t = performance.now();
  let ms = null;
  try {
    const r = await fetch('../../health', { cache: 'no-store' });
    if (r.ok) ms = Math.round(performance.now() - t);
  } catch (e) { /* down, or no connection */ }
  const el = $('server-state');
  el.className = `state ${ms === null ? 'bad' : 'ok'}`;
  el.textContent = ms === null ? 'Sem resposta' : 'Online';
  $('server-ms').textContent = ms === null ? '' : `${ms} ms`;
}
ping();
setInterval(() => { if (!document.hidden && !state.expired) ping(); }, 15_000);

hooks.shell = (t) => {
  top = t;
  if (!state.games) return;
  banner();
  library();
  sync();
};
// (the library may have been drawn before this module came in)
render();
