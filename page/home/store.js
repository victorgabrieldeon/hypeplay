// "Loja": Vimm's PS2 vault searched from here (server/vimm.ts), its games as a wall of covers drawn by the server.
// A game's page on vimm.net has a human check, so getting one stays two steps: open it there and click Download, then
// paste the download's link here (or in "Adicionar jogo"): the server downloads it into the library by itself.
import { gameOf, hooks, poll, state } from './app.js';
import { esc, gb, icon, pct } from './library.js';

const layer = document.getElementById('layer');

let st = null; // { q, games, busy, error, link, job }
let returnFocus = null;
let timer = 0;

function jobLine() {
  const v = st.job;
  if (!v || v.state === 'idle' || ((v.state === 'done' || v.state === 'failed') && v.by !== state.me)) return '';
  if (v.state === 'downloading')
    return `<div class="busy"><div class="spin"></div><p>${esc(v.by)} está baixando ${esc(v.name || 'o jogo')}: ${gb(v.received)}${v.size ? ` de ${gb(v.size)} (${Math.floor(pct(v.received, v.size))}%)` : ''}</p></div>`;
  if (v.state === 'extracting') return `<div class="busy"><div class="spin"></div><p>Abrindo ${esc(v.name || 'o arquivo')}…</p></div>`;
  if (v.state === 'done') return `<div class="callout ok">${icon('check')}<p><strong>${esc(gameOf(v.key)?.name ?? v.name)}</strong> ${v.existed ? 'já estava' : 'entrou'} na biblioteca.</p></div>`;
  return `<p class="error">${esc(v.message)}</p>`;
}

const tile = (g) => `<a class="cover store-tile" href="https://vimm.net/vault/${g.id}" target="_blank" rel="noopener noreferrer"
    aria-label="${esc(g.name)} (${esc(g.regions.join(', ') || 'região ?')}), abrir no vimm.net">
    <img src="vimm/cover/${g.id}?name=${encodeURIComponent(g.name)}" alt="" loading="lazy">
    <span class="cap"><b>${esc(g.name)}</b><span class="state">${esc([g.regions.join(' · '), g.rating && `★ ${g.rating}`].filter(Boolean).join('  '))}</span></span>
  </a>`;

function render() {
  if (!st) return;
  const busy = st.job?.state === 'downloading' || st.job?.state === 'extracting';
  const list = st.busy ? `<div class="busy"><div class="spin"></div><p>Procurando no vimm.net…</p></div>`
    : st.games === null ? '<p>Busque pelo nome, ou digite uma letra para ver todos os jogos com ela.</p>'
    : st.games.length ? `<p>${st.games.length} ${st.games.length === 1 ? 'jogo' : 'jogos'}. Clique em um para abrir a página dele no vimm.net.</p><div class="store-grid">${st.games.map(tile).join('')}</div>`
    : `<p>Nada encontrado para “${esc(st.q)}”.</p>`;
  layer.innerHTML = `<div class="modal" data-l="scrim"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="l-title">
    <header><h2 id="l-title">Loja</h2><button class="btn quiet" data-l="close" aria-label="Fechar">${icon('close')}</button></header>
    <form class="row-actions" data-l="search"><input class="field" id="l-q" type="search" placeholder="Nome do jogo, ou uma letra" value="${esc(st.q)}" aria-label="Buscar jogo de PS2">
      <button class="btn">Buscar</button></form>
    ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
    ${list}
    <div class="block">
      <h3>Achou o jogo? Traga para o servidor</h3>
      <p>Na página dele no vimm.net, clique em Download, cancele o download e copie o link dele na lista de downloads do navegador. Cole aqui:</p>
      <div class="row-actions"><input class="field" id="l-link" placeholder="https://dl3.vimm.net/?mediaId=…" value="${esc(st.link)}">
        <button class="btn second" data-l="get"${busy ? ' disabled' : ''}>${icon('download')}Baixar no servidor</button></div>
      <div id="l-job">${jobLine()}</div></div>
  </div></div>`;
}

async function search(q) {
  Object.assign(st, { q, busy: true, error: '' });
  render();
  const r = await fetch(`vimm/search?q=${encodeURIComponent(q)}`).catch(() => null);
  const res = await r?.json().catch(() => ({})) ?? {};
  if (!st || st.q !== q) return; // (closed, or another search meanwhile)
  Object.assign(st, { busy: false, games: r?.ok ? res.games : st.games, error: r?.ok ? '' : res.error || 'Não deu para buscar.' });
  render();
  document.getElementById('l-q')?.focus();
}

async function follow() {
  clearTimeout(timer);
  const v = await fetch('vimm', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!st || !v) return;
  if (v.state === 'done' && st.job?.state !== 'done') poll();
  st.job = v;
  // (only the line and the button: the results keep their scroll and the fields their focus)
  const line = document.getElementById('l-job');
  if (line) line.innerHTML = jobLine();
  const button = layer.querySelector('[data-l="get"]');
  if (button) button.disabled = v.state === 'downloading' || v.state === 'extracting';
  if (v.state === 'downloading' || v.state === 'extracting') timer = setTimeout(follow, 1000);
}

async function get() {
  const r = await fetch('vimm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: st.link }) });
  const res = await r.json().catch(() => ({}));
  st.job = r.ok ? res : { state: 'failed', by: state.me, message: res.error || `Erro ${r.status}` };
  render();
  if (r.ok) follow();
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
  if (q) search(q);
});
layer.addEventListener('input', (e) => { if (st && e.target.id === 'l-link') st.link = e.target.value.trim(); });
layer.addEventListener('click', (e) => {
  if (!st) return;
  const el = e.target.closest('[data-l]');
  const a = el?.dataset.l;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  if (a === 'close' || a === 'scrim') return close();
  if (a === 'get') return get();
});
document.addEventListener('keydown', (e) => {
  if (st && e.key === 'Escape') { e.stopPropagation(); close(); }
}, true);

hooks.store = () => {
  returnFocus = document.activeElement;
  st = { q: '', games: null, busy: false, error: '', link: '', job: null };
  render();
  follow();
  document.getElementById('l-q').focus();
};
