// The homebrew shelf (server/homebrew.ts): Homebrew Hub's free GB, GBC, GBA and NES games, played in EmulatorJS
// (page/play.html). The list is fetched once (the server keeps it a day) and filtered here.
import { hooks } from './app.js';
import { esc } from './library.js';

const PAGE = 48;
const $ = (id) => document.getElementById(id);
let games = null;
let shown = PAGE;
let platform = '';

function card(g) {
  const cover = g.cover ? `<img src="homebrew/${encodeURIComponent(g.slug)}/cover" loading="lazy" alt="">` : `<span class="ph">${esc(g.platform)}</span>`;
  return `<article class="card">
    <button class="cover" data-hb="${esc(g.slug)}" aria-label="Jogar ${esc(g.title)}">${cover}<span class="chip tag">${esc(g.platform)}</span></button>
    <h3>${esc(g.title)}</h3>
    ${g.developer ? `<p class="by">${esc(g.developer)}</p>` : ''}
  </article>`;
}

function render() {
  if (!games) return;
  const words = $('hb-q').value.toLowerCase().split(/\s+/).filter(Boolean);
  const found = games.filter((g) => (!platform || g.platform === platform) &&
    words.every((w) => g.title.toLowerCase().includes(w) || g.developer.toLowerCase().includes(w) || g.tags.some((t) => t.toLowerCase().includes(w))));
  $('n-hb').textContent = games.length ? String(games.length) : '';
  $('hb-count').textContent = `${found.length} de ${games.length} jogos do Homebrew Hub, cada um com a licença do autor`;
  $('hb-grid').innerHTML = found.length
    ? found.slice(0, shown).map(card).join('')
    : `<p class="note">${games.length ? 'Nenhum jogo encontrado.' : 'O servidor ainda está buscando a lista do Homebrew Hub…'}</p>`;
  $('hb-more').hidden = found.length <= shown;
}

/** `isExpired()`: stop trying once the pass is gone. */
export async function loadHomebrew(isExpired) {
  try {
    const r = await fetch('homebrew', { cache: 'no-store' });
    if (r.ok) games = (await r.json()).games;
  } catch (e) { /* tries again below */ }
  render();
  // The first time the server starts, the list takes a minute or two to come in.
  if (!games?.length) setTimeout(() => { if (!isExpired()) loadHomebrew(isExpired); }, 15000);
}

$('hb-q').addEventListener('input', () => { shown = PAGE; render(); });
$('hb-plat').addEventListener('click', (e) => {
  const b = e.target.closest('[data-plat]');
  if (!b) return;
  platform = b.dataset.plat;
  shown = PAGE;
  for (const x of $('hb-plat').children) x.setAttribute('aria-pressed', String(x === b));
  render();
});
$('hb-more').addEventListener('click', () => { shown += PAGE; render(); });
$('hb-grid').addEventListener('click', (e) => {
  const slug = e.target.closest('[data-hb]')?.dataset.hb;
  const g = slug && games.find((x) => x.slug === slug);
  if (!g) return;
  const url = 'play/?' + new URLSearchParams({ g: g.slug, p: g.platform, t: g.title });
  // (inside Discord: here or in the browser, intro.js asks)
  if (hooks.where) hooks.where(g.title, () => (location.href = url), location.pathname + url);
  else location.href = url;
});
