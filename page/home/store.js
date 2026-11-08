// "Loja": a page of the home (#loja), in place of the library while it's open. Vimm's PS2 vault (server/vimm.ts): the
// month's most downloaded and the best rated, as vimm.net lists them, and its search; covers and screenshots from
// libretro-thumbnails. A game's page (#loja/<id>) installs it in two steps, because vimm.net's game page has a human
// check the server can't pass: open it there and click Download, then paste the download's link here; the server
// downloads the game into the library by itself.
import { gameOf, poll, state } from './app.js';
import { esc, gb, icon, pct } from './library.js';

const $ = (id) => document.getElementById(id);
const page = $('store');
const MONTH = new Date().toLocaleString('pt-BR', { month: 'long' });

const st = { lists: null, error: '', q: '', results: null, searching: false, featured: 0, link: '', job: null, step: 0 };
/** Every game seen, by id: a game's page shows what its list said. */
const known = new Map();
const remember = (games) => { for (const g of games) known.set(g.id, { ...known.get(g.id), ...g }); return games; };

const box = (g) => (g.box ? `vimm/art/box/${encodeURIComponent(g.box)}` : `vimm/cover/${g.id}?name=${encodeURIComponent(g.name)}`);
const snap = (g) => (g.snap ? `vimm/art/snap/${encodeURIComponent(g.snap)}` : box(g));
const regions = (g) => (g.regions?.length ? g.regions.join(' · ') : '');

const tile = (g, rank) => `<a class="store-tile" href="#loja/${g.id}">
    <span class="art"><img src="${esc(box(g))}" alt="" loading="lazy">${rank ? `<i class="rank num">${rank}</i>` : ''}</span>
    <b>${esc(g.name)}</b>${regions(g) || g.rating ? `<small>${esc([regions(g), g.rating && `★ ${g.rating}`].filter(Boolean).join('  '))}</small>` : ''}
  </a>`;

const row = (title, sub, games, ranked) => `<section class="store-row"><div class="section-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>
    <div class="store-strip">${games.map((g, i) => tile(g, ranked && i + 1)).join('')}</div></section>`;

function hero() {
  const top = st.lists.top.slice(0, 5);
  const n = st.featured % top.length;
  const g = top[n];
  if (!g) return '';
  return `<section class="store-hero" aria-label="Em destaque">
    <img class="bg" src="${esc(snap(g))}" alt="">
    <a class="box" href="#loja/${g.id}" aria-label="${esc(g.name)}"><img src="${esc(box(g))}" alt=""></a>
    <div class="about"><span class="tag">Nº ${n + 1} em ${esc(MONTH)}</span><h2>${esc(g.name)}</h2>
      <a class="btn" href="#loja/${g.id}">${icon('download')}Ver e instalar</a>
      <div class="dots">${top.map((t, i) => `<button type="button" class="${i === n ? 'on' : ''}" data-feature="${i}" aria-label="${esc(t.name)}"></button>`).join('')}</div></div>
  </section>`;
}

function front() {
  const search = `<form class="store-search" data-store-search role="search"><input class="field" id="store-q" type="search" placeholder="Buscar jogo de PS2 (ou uma letra)" value="${esc(st.q)}" aria-label="Buscar jogo de PS2">
      <button class="btn second">Buscar</button></form>`;
  const head = `<div class="store-head"><h1 id="store-title">Loja</h1>${search}</div>${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}`;
  if (st.searching) return `${head}<div class="busy"><div class="spin"></div><p>Procurando no vimm.net…</p></div>`;
  if (st.results) {
    const n = st.results.length;
    return `${head}<div class="section-head"><h2>${n ? `${n} ${n === 1 ? 'jogo' : 'jogos'} para “${esc(st.q)}”` : `Nada encontrado para “${esc(st.q)}”`}</h2>
      <span><button type="button" class="btn quiet small" data-store-clear>Voltar à vitrine</button></span></div><div class="store-grid">${st.results.map((g) => tile(g)).join('')}</div>`;
  }
  if (!st.lists) return `${head}${st.error ? '' : '<div class="busy"><div class="spin"></div><p>Abrindo a loja…</p></div>'}`;
  return `${head}${hero()}
    ${row(`Mais baixados de ${MONTH}`, 'No vimm.net, este mês', st.lists.top, true)}
    ${row('Melhor avaliados', 'Nota geral no vimm.net', st.lists.rated, false)}`;
}

function jobLine() {
  const v = st.job;
  if (!v || v.state === 'idle' || ((v.state === 'done' || v.state === 'failed') && v.by !== state.me)) return '';
  if (v.state === 'downloading')
    return `<div class="busy"><div class="spin"></div><p>${esc(v.by)} está baixando ${esc(v.name || 'o jogo')}: ${gb(v.received)}${v.size ? ` de ${gb(v.size)} (${Math.floor(pct(v.received, v.size))}%)` : ''}</p></div>`;
  if (v.state === 'extracting') return `<div class="busy"><div class="spin"></div><p>Abrindo ${esc(v.name || 'o arquivo')}…</p></div>`;
  if (v.state === 'done') return `<div class="callout ok">${icon('check')}<p><strong>${esc(gameOf(v.key)?.name ?? v.name)}</strong> ${v.existed ? 'já estava' : 'entrou'} na biblioteca.</p></div>`;
  return `<p class="error">${esc(v.message)}</p>`;
}

function game(g) {
  const busy = st.job?.state === 'downloading' || st.job?.state === 'extracting';
  const facts = [regions(g) && ['Região', regions(g)], g.version && ['Versão', g.version], g.rating && ['Nota no vimm.net', `★ ${g.rating}`]].filter(Boolean);
  return `<a class="store-back" href="#loja">← Loja</a>
    <section class="store-game">
      <img class="bg" src="${esc(snap(g))}" alt="">
      <img class="box" src="${esc(box(g))}" alt="Capa de ${esc(g.name)}">
      <div class="about"><h1 id="store-title">${esc(g.name)}</h1>
        ${facts.length ? `<dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
        <div class="install">
          <h2>Instalar no servidor</h2>
          <ol>
            <li class="${st.step > 0 ? 'done' : ''}"><p>Abra o jogo no vimm.net e clique em <b>Download</b> lá (o site pede uma verificação que só uma pessoa passa).
              Assim que o download começar, cancele.</p>
              <a class="btn${st.step > 0 ? ' second' : ''}" href="https://vimm.net/vault/${g.id}" target="_blank" rel="noopener noreferrer" data-store-open>${icon('external')}Abrir no vimm.net</a></li>
            <li><p>Copie o link do download na lista de downloads do navegador e cole aqui. O servidor baixa sozinho, sem passar pelo seu PC.</p>
              <div class="row-actions"><input class="field" id="store-link" placeholder="https://dl3.vimm.net/?mediaId=…" value="${esc(st.link)}">
                <button type="button" class="btn${st.step > 0 ? '' : ' second'}" data-store-get${busy ? ' disabled' : ''}>${icon('download')}Instalar</button></div></li>
          </ol>
          <div id="store-job">${jobLine()}</div>
        </div></div>
    </section>`;
}

const at = () => /^#loja(?:\/(\d+))?$/.exec(location.hash);

function render() {
  const m = at();
  document.body.classList.toggle('in-store', !!m);
  page.hidden = !m;
  for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('on', !m && b.dataset.nav === 'library');
  document.querySelector('[data-store]')?.classList.toggle('on', !!m);
  if (!m) return;
  const g = m[1] && known.get(Number(m[1]));
  page.innerHTML = m[1] && !g ? '<a class="store-back" href="#loja">← Loja</a><div class="busy"><div class="spin"></div><p>Abrindo…</p></div>' : g ? game(g) : front();
}

async function load() {
  if (st.lists) return;
  const r = await fetch('vimm/store').catch(() => null);
  const res = (await r?.json().catch(() => null)) ?? {};
  if (r?.ok) {
    st.lists = { top: remember(res.top), rated: remember(res.rated) };
    st.error = '';
  } else st.error = res.error || 'Não deu para abrir a loja. Tente de novo.';
  // (a game's page opened by its address, for a game none of the lists has: back to the front)
  const m = at();
  if (m?.[1] && !known.has(Number(m[1]))) location.hash = 'loja';
  render();
}

async function search(q) {
  Object.assign(st, { q, searching: true, results: null, error: '' });
  render();
  const r = await fetch(`vimm/search?q=${encodeURIComponent(q)}`).catch(() => null);
  const res = (await r?.json().catch(() => null)) ?? {};
  if (st.q !== q) return; // (another search meanwhile)
  Object.assign(st, { searching: false, results: r?.ok ? remember(res.games) : null, error: r?.ok ? '' : res.error || 'Não deu para buscar.' });
  render();
  $('store-q')?.focus();
}

let timer = 0;
async function follow() {
  clearTimeout(timer);
  const v = await fetch('vimm', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!v) return;
  if (v.state === 'done' && st.job?.state !== 'done') poll();
  st.job = v;
  // (only the line and the button: the page keeps its scroll and the link field its focus)
  const line = $('store-job');
  if (line) line.innerHTML = jobLine();
  const button = page.querySelector('[data-store-get]');
  if (button) button.disabled = v.state === 'downloading' || v.state === 'extracting';
  if (v.state === 'downloading' || v.state === 'extracting') timer = setTimeout(follow, 1000);
}

async function install() {
  st.link = $('store-link').value.trim();
  const r = await fetch('vimm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: st.link }) });
  const res = await r.json().catch(() => ({}));
  st.job = r.ok ? res : { state: 'failed', by: state.me, message: res.error || `Erro ${r.status}` };
  $('store-job').innerHTML = jobLine();
  if (r.ok) follow();
}

page.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-store-search]')) return;
  e.preventDefault();
  const q = $('store-q').value.trim();
  if (q) search(q);
});
page.addEventListener('click', (e) => {
  const el = e.target.closest('[data-feature],[data-store-clear],[data-store-open],[data-store-get]');
  if (!el) return;
  if (el.dataset.feature) { st.featured = Number(el.dataset.feature); return render(); }
  if ('storeClear' in el.dataset) { Object.assign(st, { q: '', results: null }); return render(); }
  // (after the new tab opens: the paste step becomes the main one)
  if ('storeOpen' in el.dataset) { st.step = 1; return setTimeout(render); }
  if ('storeGet' in el.dataset) return install();
});
page.addEventListener('input', (e) => { if (e.target.id === 'store-link') st.link = e.target.value.trim(); });

let shown = at()?.[1] ?? '';
addEventListener('hashchange', () => {
  // (another game's page starts from its first step, at the top, like a new page)
  const now = at()?.[1] ?? '';
  if (now !== shown) { st.step = 0; scrollTo(0, 0); }
  shown = now;
  render();
  if (at()) load();
});
document.querySelector('[data-store]').addEventListener('click', () => { location.hash = 'loja'; });
// (the library's sections leave the loja first)
for (const b of document.querySelectorAll('[data-nav]')) b.addEventListener('click', () => { if (at()) { history.pushState(null, '', location.pathname + location.search); render(); } });

render();
if (at()) load();
follow();
