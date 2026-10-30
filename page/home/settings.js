// "Servidor": what the server keeps once for everyone, sent from here: the PS2 BIOS (the console's own 4 MB file, needed
// by every PS2 game) and the intro that plays before a game (intro.mp4). Both are files people bring themselves:
// nothing of them ships with HypePlay. Anyone may send, replace or take them off.
import { hooks } from './app.js';
import { esc, icon, sendBios } from './library.js';

const layer = document.getElementById('layer');
const INTRO_MAX = 64 * 1024 ** 2;

let st = null; // { bios, intro, busy, error }
let returnFocus = null;

async function load() {
  const [bios, intro] = await Promise.all([
    fetch('bios', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { present: false })).catch(() => ({ present: false })),
    fetch('intro.mp4', { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false),
  ]);
  Object.assign(st, { bios, intro });
}

function render() {
  if (!st) return;
  const has = (on, yes, no) => (on ? `<span class="state ok">${yes}</span>` : `<span class="state warn">${no}</span>`);
  layer.innerHTML = `<div class="modal" data-s="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="s-title">
    <header><h2 id="s-title">Servidor</h2><button class="btn quiet" data-s="close" aria-label="Fechar">${icon('close')}</button></header>
    <p>O que fica guardado uma vez, para todo mundo que joga neste servidor.</p>
    <div class="setting">
      <div><h3>BIOS do PS2</h3>${has(st.bios.present, 'Enviada', 'Falta')}
        <p>O arquivo de 4 MB do console (.bin ou .ROM0). Todo jogo de PS2 precisa dela.</p></div>
      <button class="btn second small" data-s="bios">${icon('upload')}${st.bios.present ? 'Trocar' : 'Enviar'}</button>
    </div>
    <div class="setting">
      <div><h3>Intro</h3>${has(st.intro, 'Toca ao abrir um jogo', 'Sem intro')}
        <p>O vídeo que toca antes de cada jogo de PS2 (MP4, até 64 MB). Sem ele, o jogo abre direto.</p></div>
      <div class="row-actions">${st.intro ? `<button class="btn quiet small" data-s="watch">${icon('play')}Ver</button><button class="btn quiet small" data-s="nointro">Tirar</button>` : ''}
        <button class="btn second small" data-s="intro">${icon('upload')}${st.intro ? 'Trocar' : 'Enviar'}</button></div>
    </div>
    ${st.busy ? `<div class="busy"><div class="spin"></div><p>${esc(st.busy)}</p></div>` : ''}
    ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
    <footer><button class="btn second" data-s="close">Fechar</button></footer></div></div>`;
}

function close() {
  st = null;
  layer.innerHTML = '';
  returnFocus?.focus?.({ preventScroll: true });
}

function pick(accept, then) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener('change', () => input.files[0] && then(input.files[0]));
  input.click();
}

/** Runs `work` with `busy` shown; its result is the error to show ('' when it went fine). */
async function doing(busy, work) {
  Object.assign(st, { busy, error: '' });
  render();
  const error = await work().catch((e) => `Não deu certo (${e?.message ?? e}).`);
  if (!st) return;
  await load();
  Object.assign(st, { busy: '', error });
  render();
}

function sendIntro(file) {
  if (file.size > INTRO_MAX) return Object.assign(st, { error: 'O vídeo pode ter até 64 MB.' }) && render();
  return doing('Enviando a intro…', async () => {
    const r = await fetch('intro.mp4', { method: 'PUT', body: file });
    return r.ok ? '' : (await r.json().catch(() => ({}))).error || `Erro ${r.status}`;
  });
}

/** The intro as it plays before a game, then back here. */
function watch() {
  layer.innerHTML = `<div class="intro" role="dialog" aria-label="Intro"><video src="intro.mp4?${Date.now()}" autoplay playsinline></video>
    <small>Clique para voltar</small></div>`;
  const back = () => render();
  layer.querySelector('video').addEventListener('ended', back);
  layer.querySelector('.intro').addEventListener('click', back);
}

layer.addEventListener('click', (e) => {
  if (!st) return;
  const el = e.target.closest('[data-s]');
  const a = el?.dataset.s;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  if (a === 'close' || a === 'scrim') return close();
  if (a === 'bios') return pick('.bin,.rom0,.ROM0,application/octet-stream', (f) => doing('Enviando a BIOS…', () => sendBios(f, st.bios.present)));
  if (a === 'intro') return pick('video/mp4,.mp4', sendIntro);
  if (a === 'watch') return watch();
  if (a === 'nointro' && confirm('Tirar a intro para todo mundo? Os jogos passam a abrir direto.'))
    return doing('Tirando a intro…', async () => ((await fetch('intro.mp4', { method: 'DELETE' })).ok ? '' : 'Não deu para tirar a intro.'));
});
document.addEventListener('keydown', (e) => {
  if (st && e.key === 'Escape') { e.stopPropagation(); close(); }
}, true);

hooks.settings = async () => {
  returnFocus = document.activeElement;
  st = { bios: { present: false }, intro: false, busy: '', error: '' };
  await load();
  render();
  layer.querySelector('.dialog button[data-s="bios"]')?.focus();
};
