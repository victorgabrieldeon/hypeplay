// "Loja": a page of the home (#loja), with Vimm's top downloads, ratings and search, and libretro artwork.
// Public snapshot metadata enables direct installation for mapped editions; other editions keep the manual link.
import { gameOf, state } from './app.js';
import { esc, gb, icon, installing, pct } from './library.js';

const $ = (id) => document.getElementById(id);
const page = $('store');
const MONTH = new Date().toLocaleString('pt-BR', { month: 'long' });

const st = { lists: null, error: '', q: '', results: null, searching: false, searchId: 0, starting: false, featured: 0, link: '', job: state.vimm, step: 0 };
/** Every game seen, by id: a game's page shows what its list said. */
const known = new Map();
const remember = (games) => { for (const g of games) known.set(g.id, { ...known.get(g.id), ...g }); return games; };

const box = (g) => (g.box ? `vimm/art/box/${encodeURIComponent(g.box)}` : `vimm/cover/${g.id}?name=${encodeURIComponent(g.name)}`);
const snap = (g) => (g.snap ? `vimm/art/snap/${encodeURIComponent(g.snap)}` : box(g));
const regions = (g) => (g.regions?.length ? g.regions.join(' · ') : '');

const tile = (g, rank) => `<a class="store-tile" href="#loja/${g.id}">
    <span class="art"><img src="${esc(box(g))}" alt="" loading="lazy">${rank ? `<i class="rank num">${rank}</i>` : ''}</span>
    <b>${esc(g.name)}</b>${regions(g) || g.rating ? `<small>${esc([regions(g), g.rating && `★ ${g.rating}`].filter(Boolean).join('  '))}</small>` : ''}
    ${g.automatic ? '<small>Instalação direta</small>' : ''}
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
  if (v.state === 'resolving') return `<div class="busy"><div class="spin"></div><p>Localizando o link de download…</p></div>`;
  if (v.state === 'downloading')
    return `<div class="busy"><div class="spin"></div><p>${esc(v.by)} está baixando ${esc(v.name || 'o jogo')}: ${gb(v.received)}${v.size ? ` de ${gb(v.size)} (${Math.floor(pct(v.received, v.size))}%)` : ''}</p></div>`;
  if (v.state === 'extracting') return `<div class="busy"><div class="spin"></div><p>Abrindo ${esc(v.name || 'o arquivo')}…</p></div>`;
  if (v.state === 'done') return `<div class="callout ok">${icon('check')}<p><strong>${esc(gameOf(v.key)?.name ?? v.name)}</strong> ${v.existed ? 'já estava' : 'entrou'} na biblioteca.</p></div>`;
  return `<p class="error">${esc(v.message)}</p>`;
}

function game(g) {
  const busy = st.starting || installing(st.job);
  const facts = [regions(g) && ['Região', regions(g)], g.version && ['Versão', g.version], g.rating && ['Nota no vimm.net', `★ ${g.rating}`]].filter(Boolean);
  const manual = `<ol>
    <li class="${st.step > 0 ? 'done' : ''}"><p>Abra o jogo no vimm.net e clique em <b>Download</b> lá (o site pede uma verificação que só uma pessoa passa).
      Assim que o download começar, cancele.</p>
      <a class="btn second" href="https://vimm.net/vault/${g.id}" target="_blank" rel="noopener noreferrer" data-store-open>${icon('external')}Abrir no vimm.net</a></li>
    <li><p>Copie o link do download na lista de downloads do navegador e cole aqui. Também aceita a página de uma edição mapeada.</p>
      <div class="row-actions"><input class="field" id="store-link" aria-label="Página ou link de download do Vimm" placeholder="https://dl2.vimm.net/?mediaId=…" value="${esc(st.link)}">
        <button type="button" class="btn second" data-store-get${busy ? ' disabled' : ''}>${icon('download')}Instalar pelo link</button></div></li>
  </ol>`;
  return `<a class="store-back" href="#loja">← Loja</a>
    <section class="store-game">
      <img class="bg" src="${esc(snap(g))}" alt="">
      <img class="box" src="${esc(box(g))}" alt="Capa de ${esc(g.name)}">
      <div class="about"><h1 id="store-title">${esc(g.name)}</h1>
        ${facts.length ? `<dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
        <div class="install">
          <h2>Instalar no servidor</h2>
          ${g.automatic ? `<p>Essa edição tem instalação direta: o servidor encontra o download sem abrir o Vimm. Use apenas jogos que você tem.</p>
            <button type="button" class="btn" data-store-install="${g.id}"${busy ? ' disabled' : ''}>${icon('download')}Instalar no servidor</button>
            <details><summary>Usar outro link</summary>${manual}</details>`
            : `<p>Essa edição não está no catálogo automático. Use o link manual ou envie sua ISO em Adicionar jogo.</p>${manual}`}
          <div id="store-job" role="status">${jobLine()}</div>
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
  const m = at();
  if (m?.[1] && !known.has(Number(m[1]))) location.hash = 'loja';
  render();
}

async function search(q) {
  const request = ++st.searchId;
  Object.assign(st, { q, searching: true, results: null, error: '' });
  render();
  const r = await fetch(`vimm/search?q=${encodeURIComponent(q)}`).catch(() => null);
  const res = (await r?.json().catch(() => null)) ?? {};
  if (request !== st.searchId) return;
  Object.assign(st, { searching: false, results: r?.ok ? remember(res.games) : null, error: r?.ok ? '' : res.error || 'Não deu para buscar.' });
  render();
  $('store-q')?.focus();
}

/** The download as app.js' vimm/ws pushes it: only the line and the buttons, the rest of the page stays. */
function follow(v) {
  st.job = v;
  const line = $('store-job');
  if (line) line.innerHTML = jobLine();
  for (const button of page.querySelectorAll('[data-store-get], [data-store-install]')) button.disabled = st.starting || installing(v);
}
addEventListener('vimm', (e) => follow(e.detail));

/** `g`: the game whose page this is: its name and box art go along, for the library's cover. */
async function install(link, g) {
  if (st.starting || installing(st.job)) return;
  st.starting = true;
  render();
  const r = await fetch('vimm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link, title: g?.name, box: g?.box || undefined }) }).catch(() => null);
  const res = await r?.json().catch(() => ({})) ?? {};
  st.starting = false;
  // (the socket may have told a later step already)
  st.job = r?.ok ? (installing(state.vimm) ? state.vimm : res) : { state: 'failed', by: state.me, message: res.error || 'Não deu para iniciar a instalação. Tente de novo.' };
  render();
}

page.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-store-search]')) return;
  e.preventDefault();
  const q = $('store-q').value.trim();
  if (q) return search(q);
});
page.addEventListener('click', (e) => {
  const el = e.target.closest('[data-feature],[data-store-clear],[data-store-open],[data-store-get],[data-store-install]');
  if (!el) return;
  if ('feature' in el.dataset) { st.featured = Number(el.dataset.feature); return render(); }
  if ('storeClear' in el.dataset) { ++st.searchId; Object.assign(st, { q: '', results: null, searching: false }); return render(); }
  if ('storeOpen' in el.dataset) { st.step = 1; return setTimeout(render); }
  const g = known.get(Number(at()?.[1]));
  if ('storeInstall' in el.dataset) return install(`https://vimm.net/vault/${el.dataset.storeInstall}`, g);
  if ('storeGet' in el.dataset) return install($('store-link').value.trim(), g);
});
page.addEventListener('input', (e) => { if (e.target.id === 'store-link') st.link = e.target.value.trim(); });

let shown = at()?.[1] ?? '';
addEventListener('hashchange', () => {
  ++st.searchId;
  st.searching = false;
  const now = at()?.[1] ?? '';
  if (now !== shown) { st.step = 0; scrollTo(0, 0); }
  shown = now;
  render();
  if (at()) load();
});
document.querySelector('[data-store]').addEventListener('click', () => { location.hash = 'loja'; });
for (const b of document.querySelectorAll('[data-nav]')) b.addEventListener('click', () => {
  if (at()) { ++st.searchId; st.searching = false; history.pushState(null, '', location.pathname + location.search); render(); }
});

render();
if (at()) load();
