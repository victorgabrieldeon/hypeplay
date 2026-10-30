// Opening a game: it becomes the person's last one (the spotlight), the PS2 intro plays (intro.mp4, sent once from
// the Servidor screen, with sound: the click is the gesture), and a click, a key, its end or its absence goes on to the
// game. Only BT3 and the PS2 library get it; the homebrew shelf opens its emulator straight away.
//
// Inside Discord, first "Onde jogar?": here, in the Activity, or in the browser, where games run smoother (Discord
// runs the Activity inside its own window, with less of the machine) and where the PS2 games and player 2's picture
// have to be anyway. The browser opens the library with ?play=, which plays the game there, intro and all.
import { gameOf, gameUrl, hooks, state } from './app.js';
import { esc, icon } from './library.js';

const layer = document.getElementById('layer');
const framed = window.parent !== window;

function run(g, join, online) {
  fetch('played', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: g.key }) }).catch(() => {});
  let gone = false;
  const leave = () => {
    if (gone) return;
    gone = true;
    removeEventListener('keydown', onKey, true);
    location.href = gameUrl(g, join, online);
  };
  const onKey = (e) => { e.preventDefault(); leave(); };
  layer.innerHTML = `<div class="intro" role="dialog" aria-label="Abrindo ${g.name.replace(/[<>&"]/g, '')}">
    <video src="intro.mp4" autoplay playsinline preload="auto"></video><small>Clique ou aperte uma tecla para pular</small></div>`;
  const video = layer.querySelector('video');
  video.addEventListener('ended', leave);
  video.addEventListener('error', leave);
  layer.querySelector('.intro').addEventListener('click', leave);
  addEventListener('keydown', onKey, true);
  // (a browser that still won't play sound plays it muted rather than not at all)
  video.play()?.catch(() => { video.muted = true; video.play()?.catch(leave); });
}

/** The library in the browser, straight into this game (open.ts lets exactly these through). */
const playPath = (g, join, online) =>
  `${location.pathname}?play=${encodeURIComponent(g.key)}${join ? `&join=${encodeURIComponent(join)}` : online ? '&online=1' : ''}`;

let choice = null; // { here, path }

/** "Onde jogar?": `here` plays it in the Activity (none: only the browser can), `path` is what the browser opens. */
function where({ name, here, path, only }) {
  choice = { here, path };
  layer.innerHTML = `<div class="modal" data-where="scrim"><div class="dialog where" role="dialog" aria-modal="true" aria-labelledby="where-title">
    <header><h2 id="where-title">Onde jogar?</h2><button class="btn quiet" data-where="cancel" aria-label="Fechar">${icon('close')}</button></header>
    <p>${esc(name)}</p>
    <div class="where-options">
      <button type="button" class="where-option" data-where="here"${here ? '' : ' disabled'}>${icon('play')}<b>Aqui no Discord</b>
        <span>${here ? 'Mais prático. Em PCs mais fracos pode travar.' : esc(only)}</span></button>
      <button type="button" class="where-option best" data-where="browser">${icon('external')}<b>No navegador</b>
        <span>Mais liso: o jogo usa o PC inteiro. Abre o navegador já no jogo.</span></button>
    </div>
    <div class="where-status" role="status" hidden></div>
  </div></div>`;
  layer.querySelector('[data-where="browser"]').focus();
}

function close() {
  choice = null;
  layer.innerHTML = '';
}

/** It didn't open (no PUBLIC_URL, or Discord didn't): why, and the link to copy into the browser. */
function cantOpen(why, url) {
  if (!layer.querySelector('.where')) where({ name: 'Abrir no navegador', here: null, path: '', only: 'Esta página só abre no navegador.' });
  const box = layer.querySelector('.where-status');
  box.hidden = false;
  box.innerHTML = `<p class="error"></p>${url ? '<div class="copy"><input class="field" readonly aria-label="Link para abrir no navegador"><button type="button" class="btn small">Copiar</button></div>' : ''}`;
  box.querySelector('p').textContent = `Não deu para abrir no navegador. ${why}`;
  if (url) {
    const input = box.querySelector('input');
    input.value = url;
    box.querySelector('button').addEventListener('click', async (e) => {
      input.select();
      // (Discord's frame may not allow the clipboard: then the link stays selected for Ctrl+C)
      e.currentTarget.textContent = await navigator.clipboard?.writeText(url).then(() => 'Copiado', () => 'Ctrl+C') ?? 'Ctrl+C';
    });
  }
}

layer.addEventListener('click', (e) => {
  if (!choice) return;
  const el = e.target.closest('[data-where]');
  const a = el?.dataset.where;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  if (a === 'cancel' || a === 'scrim') return close();
  if (a === 'here' && choice.here) { const go = choice.here; close(); return go(); }
  if (a === 'browser' && choice.path) {
    parent.postMessage({ t: 'cordplay:open', path: choice.path }, '*');
    const box = layer.querySelector('.where-status');
    box.hidden = false;
    box.innerHTML = '<p class="note">Abrindo no navegador… Se o Discord perguntar, confirme.</p>';
  }
});
document.addEventListener('keydown', (e) => {
  if (choice && e.key === 'Escape') { e.stopPropagation(); close(); }
}, true);
window.addEventListener('message', (e) => {
  const m = e.data;
  if (e.source === parent && m?.t === 'cordplay:cant-open') cantOpen(typeof m.why === 'string' ? m.why : '', typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : '');
});

hooks.play = (g, join, online) => {
  if (!framed) return run(g, join, online);
  // a PS2 game (and player 2's picture) only runs in the browser; BT3's port and its Dragon Net Battle run here too
  const ps2 = g.kind === 'recomp';
  where({ name: g.name, here: ps2 ? null : () => run(g, join, online), path: playPath(g, join, online), only: 'Os jogos de PS2 só rodam no navegador.' });
};
/** For the homebrew shelf: where to play one of its games. */
hooks.where = (name, here, path) => (framed ? where({ name, here, path }) : here());

// Opened in the browser from Discord's "No navegador" (?play=): that game, once the library is in.
const asked = new URLSearchParams(location.search);
if (!framed && asked.has('play')) {
  history.replaceState(null, '', location.pathname);
  const wait = setInterval(() => {
    if (!state.games) return;
    clearInterval(wait);
    const g = gameOf(asked.get('play'));
    if (g) run(g, asked.get('join') || undefined, asked.get('online') === '1');
  }, 200);
}
