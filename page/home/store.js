// "Loja": Vimm's PS2 vault searched from here (server/vimm.ts), its games as a wall of covers drawn by the server.
// Public media metadata lets mapped editions install here; other editions keep the manual download-link fallback.
import { gameOf, hooks, poll, state } from './app.js';
import { esc, gb, icon, pct } from './library.js';

const layer = document.getElementById('layer');

let st = null; // { q, games, busy, starting, searchId, error, link, job }
let returnFocus = null;
let timer = 0;
const installing = (v) => ['resolving', 'downloading', 'extracting'].includes(v?.state);

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

const tile = (g) => `<${g.automatic ? 'button type="button"' : 'a'} class="cover store-tile" ${g.automatic
    ? `data-l="install" data-id="${g.id}"${st.starting || installing(st.job) ? ' disabled' : ''}`
    : `href="https://vimm.net/vault/${g.id}" target="_blank" rel="noopener noreferrer"`}
    aria-label="${esc(g.name)} (${esc(g.regions.join(', ') || 'região ?')}), ${g.automatic ? 'instalar no servidor' : 'abrir no vimm.net'}">
    <img src="vimm/cover/${g.id}?name=${encodeURIComponent(g.name)}" alt="" loading="lazy">
    <span class="cap"><b>${esc(g.name)}</b><span class="state">${esc(g.regions.join(' · '))} · ${g.automatic ? 'Instalar no servidor' : 'Abrir no Vimm'}</span></span>
  </${g.automatic ? 'button' : 'a'}>`;

function render() {
  if (!st) return;
  const busy = st.starting || installing(st.job);
  const list = st.busy ? `<div class="busy"><div class="spin"></div><p>Procurando no vimm.net…</p></div>`
    : st.games === null ? '<p>Busque pelo nome, ou digite uma letra para ver todos os jogos com ela.</p>'
    : st.games.length ? `<p>${st.games.length} ${st.games.length === 1 ? 'jogo' : 'jogos'}. As capas com “Instalar no servidor” baixam direto, sem abrir o site. As demais precisam do link manual.</p><div class="store-grid">${st.games.map(tile).join('')}</div>`
    : `<p>Nada encontrado para “${esc(st.q)}”.</p>`;
  layer.innerHTML = `<div class="modal" data-l="scrim"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="l-title">
    <header><h2 id="l-title">Loja</h2><button class="btn quiet" data-l="close" aria-label="Fechar">${icon('close')}</button></header>
    <form class="row-actions" data-l="search"><input class="field" id="l-q" type="search" placeholder="Nome do jogo, ou uma letra" value="${esc(st.q)}" aria-label="Buscar jogo de PS2">
      <button class="btn">Buscar</button></form>
    ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
    ${list}
    <div class="block">
      <h3>Ou cole o link do jogo</h3>
      <p>A página do jogo basta quando a edição está no catálogo automático. Se não estiver, copie o link de Download no Vimm e cole aqui. Use apenas jogos que você tem.</p>
      <div class="row-actions"><input class="field" id="l-link" aria-label="Página ou link de download do Vimm" placeholder="https://vimm.net/vault/…" value="${esc(st.link)}">
        <button class="btn second" data-l="get"${busy ? ' disabled' : ''}>${icon('download')}Instalar no servidor</button></div>
      <div id="l-job" role="status">${jobLine()}</div></div>
  </div></div>`;
}

async function search(q) {
  const current = st;
  const request = ++st.searchId;
  Object.assign(st, { q, busy: true, error: '' });
  render();
  const r = await fetch(`vimm/search?q=${encodeURIComponent(q)}`).catch(() => null);
  const res = await r?.json().catch(() => ({})) ?? {};
  if (st !== current || st.searchId !== request) return;
  Object.assign(st, { busy: false, games: r?.ok ? res.games : st.games, error: r?.ok ? '' : res.error || 'Não deu para buscar.' });
  render();
  document.getElementById('l-q')?.focus();
}

async function follow() {
  clearTimeout(timer);
  const current = st;
  const v = await fetch('vimm', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!st || st !== current) return;
  if (!v) { timer = setTimeout(follow, 1000); return; }
  if (v.state === 'done' && st.job?.state !== 'done') poll();
  st.job = v;
  // (only the line and the button: the results keep their scroll and the fields their focus)
  const line = document.getElementById('l-job');
  if (line) line.innerHTML = jobLine();
  for (const button of layer.querySelectorAll('[data-l="get"], [data-l="install"]')) button.disabled = st.starting || installing(v);
  if (installing(v)) timer = setTimeout(follow, 1000);
}

async function get(link = st.link) {
  if (st.starting || installing(st.job)) return;
  const current = st;
  st.starting = true;
  render();
  const r = await fetch('vimm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) }).catch(() => null);
  const res = await r?.json().catch(() => ({})) ?? {};
  if (st !== current) return;
  st.starting = false;
  st.job = r?.ok ? res : { state: 'failed', by: state.me, message: res.error || 'Não deu para iniciar a instalação. Tente de novo.' };
  render();
  if (r?.ok) follow();
}

function close() {
  clearTimeout(timer);
  st = null;
  layer.innerHTML = '';
  returnFocus?.focus?.({ preventScroll: true });
}

layer.addEventListener('submit', (e) => {
  if (!st || !e.target.matches('[data-l="search"]')) return;
  e.preventDefault();
  const q = document.getElementById('l-q').value.trim();
  if (q) return search(q);
});
layer.addEventListener('input', (e) => { if (st && e.target.id === 'l-link') st.link = e.target.value.trim(); });
layer.addEventListener('click', (e) => {
  if (!st) return;
  const el = e.target.closest('[data-l]');
  const a = el?.dataset.l;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  if (a === 'close' || a === 'scrim') return close();
  if (a === 'get') return get();
  if (a === 'install') return get(`https://vimm.net/vault/${el.dataset.id}`);
});
document.addEventListener('keydown', (e) => {
  if (st && e.key === 'Escape') { e.stopPropagation(); close(); }
}, true);

hooks.store = () => {
  returnFocus = document.activeElement;
  st = { q: '', games: null, busy: false, starting: false, searchId: 0, error: '', link: '', job: null };
  render();
  follow();
  document.getElementById('l-q').focus();
};
