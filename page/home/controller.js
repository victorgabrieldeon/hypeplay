// "Controle": the connected pads, and mapping one the browser doesn't know (a USB PS2 adapter, say) once, a button at
// a time over a drawing of a PS2 pad. The map is kept on the server (GET/PUT pad) and pad.js applies it in every game.
import { hooks, state } from './app.js';
import { esc, icon } from './library.js';

const layer = document.getElementById('layer');
const { STANDARD, remap, validMapping } = globalThis.CordPad;

const LABELS = { cross: '✕', circle: '○', square: '□', triangle: '△', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'Select', start: 'Start',
  l3: 'L3 (aperte o analógico esquerdo)', r3: 'R3 (aperte o analógico direito)', up: 'direcional para cima', down: 'direcional para baixo',
  left: 'direcional para a esquerda', right: 'direcional para a direita' };
/** After the 16 buttons, the sticks: one direction each tells the axis and its sign. */
const STICKS = [['lx', 'Mova o analógico esquerdo para a direita'], ['ly', 'Mova o analógico esquerdo para baixo'],
  ['rx', 'Mova o analógico direito para a direita'], ['ry', 'Mova o analógico direito para baixo']];

/** An original drawing of a PS2-style pad; each control has an id the screen lights up. */
const PAD = `<svg class="ps2" viewBox="0 0 520 300" aria-hidden="true">
  <rect id="k-l2" class="k" x="70" y="8" width="90" height="26" rx="10"/><rect id="k-r2" class="k" x="360" y="8" width="90" height="26" rx="10"/>
  <rect id="k-l1" class="k" x="70" y="38" width="90" height="22" rx="8"/><rect id="k-r1" class="k" x="360" y="38" width="90" height="22" rx="8"/>
  <path class="body" d="M120 66h280c60 0 100 40 108 110l10 70c4 34-34 52-62 30l-58-48H122l-58 48c-28 22-66 4-62-30l10-70C20 106 60 66 120 66z"/>
  <rect id="k-up" class="k" x="104" y="96" width="28" height="32" rx="5"/><rect id="k-down" class="k" x="104" y="152" width="28" height="32" rx="5"/>
  <rect id="k-left" class="k" x="72" y="126" width="32" height="28" rx="5"/><rect id="k-right" class="k" x="132" y="126" width="32" height="28" rx="5"/>
  <circle id="k-triangle" class="k" cx="400" cy="104" r="18"/><circle id="k-square" class="k" cx="364" cy="140" r="18"/>
  <circle id="k-circle" class="k" cx="436" cy="140" r="18"/><circle id="k-cross" class="k" cx="400" cy="176" r="18"/>
  <text x="400" y="109">△</text><text x="364" y="145">□</text><text x="436" y="145">○</text><text x="400" y="181">✕</text>
  <rect id="k-select" class="k" x="210" y="128" width="34" height="14" rx="7"/><rect id="k-start" class="k" x="276" y="128" width="34" height="14" rx="7"/>
  <circle id="k-l3" class="k" cx="190" cy="214" r="34"/><circle id="k-r3" class="k" cx="330" cy="214" r="34"/>
  <circle id="k-lx" class="k" cx="190" cy="214" r="12" style="opacity:.0"/><circle id="k-ry" class="k" cx="330" cy="214" r="12" style="opacity:.0"/>
  <circle id="dot-l" cx="190" cy="214" r="10" fill="#a08cff"/><circle id="dot-r" cx="330" cy="214" r="10" fill="#a08cff"/>
</svg>`;

let s = null; // { view: 'list' | 'map' | 'test' | 'blocked', pad, maps, map, step, rest, waitRelease, skipped }
let timer = 0;
/** Reads the pads this often: steady even when the browser slows animation frames down. */
const EVERY_MS = 30;

function pads() {
  try { return [...navigator.getGamepads()].filter(Boolean); } catch (e) { return null; }
}
const short = (id) => id.replace(/\s*\(.*$/, '').slice(0, 40) || 'Controle';

function close() {
  clearInterval(timer);
  s = null;
  layer.innerHTML = '';
}

function frame(inner) {
  layer.innerHTML = `<div class="modal" data-c="scrim"><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="c-title">
    <header><h2 id="c-title">Controle</h2><button class="btn quiet" data-c="close" aria-label="Fechar">${icon('close')}</button></header>${inner}</div></div>`;
}

function list() {
  const ps = pads();
  if (ps === null) {
    s.view = 'blocked';
    return frame(`<p>O Discord não liberou o controle nesta janela. No navegador ele funciona.</p>
      <footer>${state.publicUrl ? '<button class="btn" data-c="browser">Abrir no navegador</button>' : ''}<button class="btn second" data-c="close">Fechar</button></footer>`);
  }
  s.view = 'list';
  const rows = ps.map((p) => {
    const mapped = s.maps[p.id];
    const tag = mapped ? '<span class="state ok">Mapeado</span>' : p.mapping === 'standard' ? '<span class="state ok">Reconhecido</span>' : '<span class="state warn">Não reconhecido</span>';
    return `<div class="pad-row"><div><b>${esc(short(p.id))}</b>${tag}</div><div class="row-actions">
      <button class="btn${mapped || p.mapping === 'standard' ? ' second' : ''} small" data-c="map" data-i="${p.index}">Mapear</button>
      ${mapped ? `<button class="btn quiet small" data-c="test" data-i="${p.index}">Testar</button><button class="btn quiet small" data-c="forget" data-i="${p.index}">Esquecer</button>` : ''}
    </div></div>`;
  }).join('');
  frame(`<p>Sempre um controle de PS2. Se o navegador não reconhecer o seu (um adaptador USB, por exemplo), mapeie os botões uma vez: vale em todos os jogos, em qualquer computador.</p>
    <div class="pads">${rows || `<div class="waiting">${PAD}<div class="busy"><div class="spin"></div><p>Conecte o controle e aperte qualquer botão…</p></div></div>`}</div>
    <footer><button class="btn second" data-c="close">Fechar</button></footer>`);
}

function axesOf(p) { return [...p.axes]; }

function startMap(index) {
  const p = pads()?.find((x) => x.index === index);
  if (!p) return list();
  Object.assign(s, { view: 'map', pad: p.id, index, map: { buttons: Array(16).fill(null), axes: Array(4).fill(null) }, step: 0, rest: axesOf(p), waitRelease: true });
  drawMap();
}

function stepName() {
  return s.step < 16 ? `Aperte ${LABELS[STANDARD[s.step]]}` : STICKS[s.step - 16][1];
}

function drawMap() {
  frame(`<p class="ask" aria-live="polite">${esc(stepName())}<small>Passo ${s.step + 1} de 20</small></p>${PAD}
    <footer><button class="btn quiet" data-c="list">Cancelar</button><button class="btn second" data-c="skip">Pular</button></footer>`);
  const want = s.step < 16 ? STANDARD[s.step] : s.step < 18 ? 'lx' : 'ry';
  layer.querySelector(`#k-${want}`)?.classList.add('want');
  if (want === 'lx' || want === 'ry') layer.querySelector(`#k-${want}`).style.opacity = '1';
}

/** What moved from rest on the raw pad, if anything: a button, an axis pushed one way, or a hat value. */
function moved(p) {
  const b = p.buttons.findIndex((x) => x.pressed || x.value > 0.5);
  if (b >= 0) return { button: b };
  for (let i = 0; i < p.axes.length; i++) {
    const v = p.axes[i], r = s.rest[i] ?? 0;
    if (Math.abs(v - r) < 0.6) continue;
    // A hat rests outside [-1, 1] (3.29 on most adapters) and jumps to a value per direction.
    if (Math.abs(r) > 1.05) return { hat: i, value: Math.round(v * 100) / 100 };
    return { axis: i, dir: v > r ? 1 : -1 };
  }
  return null;
}

function tick() {
  if (!s) return;
  const p = pads()?.find((x) => x.id === s.pad || x.index === s.index);
  if (s.view === 'list') {
    if (layer.querySelector('.spin') && pads()?.length) list();
  } else if (s.view === 'map' && p) {
    const m = moved(p);
    if (s.waitRelease) { if (!m) s.waitRelease = false; }
    else if (m) {
      if (s.step < 16) s.map.buttons[s.step] = m;
      else if ('axis' in m) s.map.axes[s.step - 16] = { axis: m.axis, ...(m.dir < 0 ? { invert: true } : {}) };
      next();
    }
  } else if (s.view === 'test' && p) {
    const out = s.maps[s.pad] && validMapping(s.maps[s.pad]) ? remap(p, s.maps[s.pad]) : p;
    STANDARD.forEach((name, i) => layer.querySelector(`#k-${name}`)?.classList.toggle('lit', !!out.buttons[i]?.pressed));
    const [lx = 0, ly = 0, rx = 0, ry = 0] = out.axes;
    layer.querySelector('#dot-l')?.setAttribute('transform', `translate(${lx * 22} ${ly * 22})`);
    layer.querySelector('#dot-r')?.setAttribute('transform', `translate(${rx * 22} ${ry * 22})`);
  }
}

function next() {
  s.step++;
  s.waitRelease = true;
  if (s.step < 20) return drawMap();
  s.maps[s.pad] = s.map;
  test(s.pad, true);
}

function test(id, unsaved) {
  Object.assign(s, { view: 'test', pad: id, unsaved: !!unsaved });
  frame(`<p class="ask">Teste: aperte os botões e mexa os analógicos<small>${unsaved ? 'Se estiver tudo certo, salve.' : esc(short(id))}</small></p>${PAD}
    <footer><button class="btn quiet" data-c="list">Voltar</button>${unsaved ? '<button class="btn" data-c="save">Salvar</button>' : ''}</footer>`);
}

async function save() {
  const r = await fetch('pad', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s.maps) });
  if (!r.ok) { layer.querySelector('footer')?.insertAdjacentHTML('beforebegin', '<p class="error">Não deu para salvar o mapa. Tente de novo.</p>'); return; }
  list();
}

layer.addEventListener('click', async (e) => {
  if (!s) return;
  const el = e.target.closest('[data-c]');
  const a = el?.dataset.c;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  const index = Number(el.dataset.i);
  if (a === 'close' || a === 'scrim') return close();
  if (a === 'list') { if (s.unsaved) delete s.maps[s.pad]; s.unsaved = false; return list(); }
  if (a === 'map') return startMap(index);
  if (a === 'test') return test(pads().find((p) => p.index === index).id);
  if (a === 'skip') return next();
  if (a === 'save') return save();
  if (a === 'forget') { delete s.maps[pads().find((p) => p.index === index).id]; await save(); }
  if (a === 'browser') parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*');
});
document.addEventListener('keydown', (e) => { if (s && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
window.addEventListener('gamepadconnected', () => { if (s?.view === 'list') list(); });

hooks.controller = async () => {
  s = { view: 'list', maps: {} };
  try { const r = await fetch('pad', { cache: 'no-store' }); if (r.ok) s.maps = await r.json(); } catch (e) {}
  list();
  clearInterval(timer);
  timer = setInterval(tick, EVERY_MS);
};
