// "Controle": the connected pads, and mapping one the browser doesn't know (a USB PS2 adapter, say) once, a button at
// a time over a drawing of the pad in hand (PS2, PS5 or Xbox: pads.js), named the way that pad names it. The map is
// kept on the server (GET/PUT pad) and pad.js applies it in every game.
import { hooks, state } from './app.js';
import { esc, icon } from './library.js';
import { DRAWINGS, FAMILIES, NAMES } from './pads.js';

const layer = document.getElementById('layer');
const { STANDARD, padFamily, remap, validMapping } = globalThis.CordPad;

const PRESS = { l3: ' (aperte o analógico esquerdo)', r3: ' (aperte o analógico direito)' };
/** After the 16 buttons, the sticks: one direction each tells the axis and its sign. */
const STICKS = [['lx', 'Mova o analógico esquerdo para a direita'], ['ly', 'Mova o analógico esquerdo para baixo'],
  ['rx', 'Mova o analógico direito para a direita'], ['ry', 'Mova o analógico direito para baixo']];

let s = null; // { view: 'list' | 'map' | 'test' | 'blocked', pad, maps, map, step, rest, waitRelease, unsaved, family }
let timer = 0;
/** Reads the pads this often: steady even when the browser slows animation frames down. */
const EVERY_MS = 30;

function pads() {
  try { return [...navigator.getGamepads()].filter(Boolean); } catch (e) { return null; }
}
const short = (id) => id.replace(/\s*\(.*$/, '').slice(0, 40) || 'Controle';

/** The drawing shown: the one picked on the switch, else the one the pad's name suggests. */
const familyOf = (id) => s.family ?? padFamily(id ?? '');
const switcher = (f) => `<div class="family" role="group" aria-label="Modelo do controle">${FAMILIES
  .map(([k, title]) => `<button type="button" data-c="family" data-f="${k}" aria-pressed="${k === f}">${title}</button>`).join('')}</div>`;

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
    const kind = FAMILIES.find(([k]) => k === padFamily(p.id))[1];
    return `<div class="pad-row"><div><b>${esc(short(p.id))}</b><span class="chip">${kind}</span>${tag}</div><div class="row-actions">
      <button class="btn${mapped || p.mapping === 'standard' ? ' second' : ''} small" data-c="map" data-i="${p.index}">Mapear</button>
      ${mapped ? `<button class="btn quiet small" data-c="test" data-i="${p.index}">Testar</button><button class="btn quiet small" data-c="forget" data-i="${p.index}">Esquecer</button>` : ''}
    </div></div>`;
  }).join('');
  const f = s.family ?? 'ps2';
  frame(`<p>Vale controle de PS2 (num adaptador USB), de PS5 e de Xbox: nos jogos, os botões viram os do PS2. Se o navegador não
    reconhecer o seu, mapeie os botões uma vez: vale em todos os jogos, em qualquer computador.</p>
    <div class="pads">${rows || `<div class="waiting">${switcher(f)}${DRAWINGS[f]}<div class="busy"><div class="spin"></div><p>Conecte o controle e aperte qualquer botão…</p></div></div>`}</div>
    <footer><button class="btn second" data-c="close">Fechar</button></footer>`);
}

function axesOf(p) { return [...p.axes]; }

function startMap(index) {
  const p = pads()?.find((x) => x.index === index);
  if (!p) return list();
  Object.assign(s, { view: 'map', pad: p.id, index, map: { buttons: Array(16).fill(null), axes: Array(4).fill(null) }, step: 0, rest: axesOf(p), waitRelease: true });
  drawMap();
}

function stepName(f) {
  if (s.step >= 16) return STICKS[s.step - 16][1];
  const b = STANDARD[s.step];
  return `Aperte ${NAMES[f][b]}${PRESS[b] ?? ''}`;
}

/** On another pad than the PS2's, which PS2 button this one becomes in the games. */
function becomes(f) {
  const b = STANDARD[s.step];
  return s.step < 16 && NAMES[f][b] !== NAMES.ps2[b] ? `No jogo vira ${NAMES.ps2[b]} do PS2 · ` : '';
}

function drawMap() {
  const f = familyOf(s.pad);
  frame(`<p class="ask" aria-live="polite">${esc(stepName(f))}<small>${esc(becomes(f))}Passo ${s.step + 1} de 20</small></p>${switcher(f)}${DRAWINGS[f]}
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
  const f = familyOf(id);
  frame(`<p class="ask">Teste: aperte os botões e mexa os analógicos<small>${unsaved ? 'Se estiver tudo certo, salve.' : esc(short(id))}</small></p>${switcher(f)}${DRAWINGS[f]}
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
  if (a === 'family') {
    s.family = el.dataset.f;
    return s.view === 'map' ? drawMap() : s.view === 'test' ? test(s.pad, s.unsaved) : list();
  }
  if (a === 'save') return save();
  if (a === 'forget') { delete s.maps[pads().find((p) => p.index === index).id]; await save(); }
  if (a === 'browser') parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*');
});
document.addEventListener('keydown', (e) => { if (s && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
window.addEventListener('gamepadconnected', () => { if (s?.view === 'list') list(); });

hooks.controller = async () => {
  s = { view: 'list', maps: {}, family: null };
  try { const r = await fetch('pad', { cache: 'no-store' }); if (r.ok) s.maps = await r.json(); } catch (e) {}
  list();
  clearInterval(timer);
  timer = setInterval(tick, EVERY_MS);
};
