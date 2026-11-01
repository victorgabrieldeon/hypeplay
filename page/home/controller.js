// "Controle": the connected pads, and mapping one the browser doesn't know (a USB PS2 adapter, say) once, a button at
// a time over a drawing of the pad in hand (PS2, PS5 or Xbox: pads.js), named the way that pad names it. The map is
// kept on the server (GET/PUT pad) and pad.js applies it in every game. Also the person's own keys for the PS2 games
// (keymap.ts), a key per button and stick direction, kept the same way (GET/PUT/DELETE keys).
import { hooks, state } from './app.js';
import { esc, icon } from './library.js';
import { DRAWINGS, FAMILIES, NAMES } from './pads.js';

const layer = document.getElementById('layer');
const { STANDARD, centered, keyAllowed, keyPad, padFamily, pushed, remap, turning, validMapping } = globalThis.CordPad;

const PRESS = { l3: ' (aperte o analógico esquerdo)', r3: ' (aperte o analógico direito)' };
/**
 * After the 16 buttons, each stick (stickmap.ts): turned round first, which finds its two axes and their middles; then
 * pushed right (x and its way) and down (y and its way). Buttons pressed meanwhile don't count.
 */
const SIDE = { l: 'esquerdo', r: 'direito' };
const STICKS = ['l', 'r'].flatMap((stick) => [
  { stick, kind: 'turn', ask: `Gire o analógico ${SIDE[stick]}`, hint: 'Duas voltas completas, encostando na borda' },
  { stick, kind: 'right', ask: `Empurre o analógico ${SIDE[stick]} para a direita`, hint: 'E segure até passar' },
  { stick, kind: 'down', ask: `Empurre o analógico ${SIDE[stick]} para baixo`, hint: 'E segure até passar' },
]);
const STEPS = 16 + STICKS.length;
/** The keys' steps after the 16 buttons: each stick's four ways, in keymap.ts's order (left, right, up, down). */
const KEY_DIRS = ['l', 'r'].flatMap((stick) => [['para a esquerda', -1, 0], ['para a direita', 1, 0], ['para cima', 0, -1], ['para baixo', 0, 1]]
  .map(([way, x, y]) => ({ stick, x, y, name: `analógico ${SIDE[stick]} ${way}` })));
const KEY_STEPS = 16 + KEY_DIRS.length;

let s = null; // { view: 'list' | 'map' | 'test' | 'blocked' | 'keys' | 'ktest', pad, maps, map, step, rest, waitRelease, unsaved, family, turn, sticks, x, keys, was, kmap, held, note }
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

/** The keyboard's row: always there, also where Discord hides the pads. */
const keyRow = () => `<div class="pad-row"><div><b>Teclado</b><span class="chip">Jogos de PS2</span>${s.keys ? '<span class="state ok">Mapeado</span>' : '<span class="state">Teclas do jogo</span>'}</div>
  <div class="row-actions"><button class="btn second small" data-c="keys">Mapear</button>
  ${s.keys ? '<button class="btn quiet small" data-c="ktest">Testar</button><button class="btn quiet small" data-c="kforget">Esquecer</button>' : ''}</div></div>`;

function list() {
  const ps = pads();
  if (ps === null) {
    s.view = 'blocked';
    return frame(`<p>O Discord não liberou o controle nesta janela. No navegador ele funciona.</p><div class="pads">${keyRow()}</div>
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
    <div class="pads">${rows || `<div class="waiting">${switcher(f)}${DRAWINGS[f]}<div class="busy"><div class="spin"></div><p>Conecte o controle e aperte qualquer botão…</p></div></div>`}${keyRow()}</div>
    <footer><button class="btn second" data-c="close">Fechar</button></footer>`);
}

function axesOf(p) { return [...p.axes]; }

function startMap(index) {
  const p = pads()?.find((x) => x.index === index);
  if (!p) return list();
  Object.assign(s, { view: 'map', pad: p.id, index, map: { buttons: Array(16).fill(null), axes: Array(4).fill(null) }, step: 0, rest: axesOf(p),
    waitRelease: true, turn: null, sticks: {}, x: {}, high: new Set(), pending: null });
  drawMap();
}

function stepName(f) {
  if (s.step >= 16) return STICKS[s.step - 16].ask;
  const b = STANDARD[s.step];
  return `Aperte ${NAMES[f][b]}${PRESS[b] ?? ''}`;
}

/** On another pad than the PS2's, which PS2 button this one becomes in the games. */
function becomes(f) {
  const b = STANDARD[s.step];
  if (s.step >= 16) return `${STICKS[s.step - 16].hint} · `;
  return NAMES[f][b] !== NAMES.ps2[b] ? `No jogo vira ${NAMES.ps2[b]} do PS2 · ` : '';
}

/** Axes a stick can't be: hats (resting outside [-1, 1]), the other stick's, the ones a button was mapped to. */
function notSticks(stick) {
  const skip = new Set(s.rest.flatMap((r, i) => (Math.abs(r) > 1.05 ? [i] : [])));
  for (const [k, st] of Object.entries(s.sticks)) if (k !== stick && st) st.axes.forEach((a) => skip.add(a));
  for (const b of s.map.buttons) if (b && 'axis' in b) skip.add(b.axis);
  return skip;
}

function drawMap() {
  const f = familyOf(s.pad);
  frame(`<p class="ask" aria-live="polite">${esc(stepName(f))}<small>${esc(becomes(f))}Passo ${s.step + 1} de ${STEPS}</small></p>${switcher(f)}${DRAWINGS[f]}
    <footer><button class="btn quiet" data-c="list">Cancelar</button><button class="btn second" data-c="skip">Pular</button></footer>`);
  if (s.step < 16) return layer.querySelector(`#k-${STANDARD[s.step]}`)?.classList.add('want');
  const { stick, kind } = STICKS[s.step - 16];
  if (kind === 'turn') {
    s.turn ??= turning(notSticks(stick));
    layer.querySelector(`#k-${stick}3`)?.classList.add('want');
  } else {
    const dot = layer.querySelector(stick === 'l' ? '#k-lx' : '#k-ry');
    dot?.classList.add('want');
    if (dot) dot.style.opacity = '1';
    layer.querySelector(`#dot-${stick}`)?.setAttribute('transform', kind === 'right' ? 'translate(22 0)' : 'translate(0 22)');
  }
}

/** A stick step: turning (until both axes went round), then right, then down. True once this step is done. */
function stickStep(p) {
  const { stick, kind } = STICKS[s.step - 16];
  const base = stick === 'l' ? 0 : 2;
  if (kind === 'turn') {
    s.turn.add(p.axes);
    // (the dot follows the two axes that have gone furthest so far)
    const skip = notSticks(stick);
    const best = p.axes.map((_, i) => i).filter((i) => !skip.has(i)).sort((a, b) => s.turn.reach(b) - s.turn.reach(a)).slice(0, 2).sort((a, b) => a - b);
    if (best.length === 2) layer.querySelector(`#dot-${stick}`)?.setAttribute('transform', `translate(${(p.axes[best[0]] ?? 0) * 22} ${(p.axes[best[1]] ?? 0) * 22})`);
    const found = s.turn.stick();
    if (!found) return false;
    s.sticks[stick] = found;
    s.turn = null;
    return true;
  }
  const st = s.sticks[stick];
  const m = st && pushed(p.axes, st);
  if (!m) return false;
  if (kind === 'right') {
    s.x[stick] = m;
    s.map.axes[base] = { axis: m.axis, ...(m.dir < 0 ? { invert: true } : {}) };
    return true;
  }
  if (m.axis === s.x[stick]?.axis) return false; // (still the right push: down is the other axis)
  s.map.axes[base + 1] = { axis: m.axis, ...(m.dir < 0 ? { invert: true } : {}) };
  return true;
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

/**
 * The browser (Chrome/Firefox on Linux) reads an axis as 0 until it first moves; a trigger then rests at -1 once let
 * go. Taking that as its rest keeps it from counting as pressed forever (the wait for the release never ending after
 * L2/R2). Only while waiting for the release, or on an axis already seen going up: on a d-pad read as an axis, 0 to -1
 * is up or left being pressed.
 */
function settle(p) {
  p.axes.forEach((v, i) => {
    if (v > 0.5) s.high.add(i);
    if ((s.waitRelease || s.high.has(i)) && Math.abs(s.rest[i] ?? 0) < 0.05 && v < -0.95) s.rest[i] = v;
  });
}

function tick() {
  if (!s) return;
  const p = pads()?.find((x) => x.id === s.pad || x.index === s.index);
  if (s.view === 'list') {
    if (layer.querySelector('.spin') && pads()?.length) list();
  } else if (s.view === 'map' && p) {
    // (only on the button steps: the stick steps find their own middles)
    if (s.step < 16) settle(p);
    const m = moved(p);
    const st = s.step >= 16 ? s.sticks[STICKS[s.step - 16].stick] : null;
    // (let go first: buttons up, and the stick back in its own middle once it's known)
    if (s.waitRelease) { if (!m || (st && centered(p.axes, st) && !p.buttons.some((x) => x.pressed))) s.waitRelease = false; }
    else if (s.step < 16) {
      // (0 to -1 waits: back at 0 a while it's that press (d-pad up/left), going on up it's a trigger touched for the
      // first time, passing 0 on its way)
      const wait = m && 'axis' in m && m.dir < 0 && Math.abs(s.rest[m.axis] ?? 0) < 0.05;
      if (wait) Object.assign(s, { pending: m, still: 0 });
      else if (s.pending && !m) s.still = Math.abs(p.axes[s.pending.axis]) < 0.05 ? s.still + 1 : 0;
      const got = wait ? null : m ?? (s.still >= 3 ? s.pending : null);
      if (got) {
        s.map.buttons[s.step] = got;
        next();
      }
    } else if (stickStep(p)) next();
  } else if (s.view === 'test' && p) light(s.maps[s.pad] && validMapping(s.maps[s.pad]) ? remap(p, s.maps[s.pad]) : p);
  else if (s.view === 'ktest') light(keyPad(s.keys, s.held, 0));
}

/** The test drawing: the buttons held lit, the sticks' dots where they point. */
function light(out) {
  STANDARD.forEach((name, i) => layer.querySelector(`#k-${name}`)?.classList.toggle('lit', !!out.buttons[i]?.pressed));
  const [lx = 0, ly = 0, rx = 0, ry = 0] = out.axes;
  layer.querySelector('#dot-l')?.setAttribute('transform', `translate(${lx * 22} ${ly * 22})`);
  layer.querySelector('#dot-r')?.setAttribute('transform', `translate(${rx * 22} ${ry * 22})`);
}

const keyName = (i) => (i < 16 ? NAMES.ps2[STANDARD[i]] : KEY_DIRS[i - 16].name);

function startKeys() {
  Object.assign(s, { view: 'keys', kmap: { buttons: Array(16).fill(null), sticks: Array(8).fill(null) }, step: 0, note: '' });
  drawKeys();
}

function drawKeys() {
  const name = keyName(s.step);
  frame(`<p class="ask" aria-live="polite">${esc(name[0].toUpperCase() + name.slice(1))}<small>${esc(s.note || 'Aperte a tecla para ele')} · Passo ${s.step + 1} de ${KEY_STEPS}</small></p>${DRAWINGS.ps2}
    <footer><button class="btn quiet" data-c="list">Cancelar</button><button class="btn second" data-c="skip">Pular</button></footer>`);
  if (s.step < 16) return layer.querySelector(`#k-${STANDARD[s.step]}`)?.classList.add('want');
  const { stick, x, y } = KEY_DIRS[s.step - 16];
  layer.querySelector(`#k-${stick}3`)?.classList.add('want');
  layer.querySelector(`#dot-${stick}`)?.setAttribute('transform', `translate(${x * 22} ${y * 22})`);
}

function takeKey(code) {
  if (!keyAllowed(code)) { s.note = 'Essa tecla não dá: escolha outra'; return drawKeys(); }
  const taken = [...s.kmap.buttons, ...s.kmap.sticks].indexOf(code);
  if (taken >= 0) { s.note = `Essa tecla já é ${keyName(taken)}`; return drawKeys(); }
  if (s.step < 16) s.kmap.buttons[s.step] = code;
  else s.kmap.sticks[s.step - 16] = code;
  nextKey();
}

function nextKey() {
  s.step++;
  s.note = '';
  if (s.step < KEY_STEPS) return drawKeys();
  Object.assign(s, { was: s.keys, keys: s.kmap });
  keyTest(true);
}

function keyTest(unsaved) {
  Object.assign(s, { view: 'ktest', unsaved: !!unsaved, held: new Set() });
  frame(`<p class="ask">Teste: aperte as teclas<small>${unsaved ? 'Se estiver tudo certo, salve.' : 'Teclado'}</small></p>${DRAWINGS.ps2}
    <footer><button class="btn quiet" data-c="list">Voltar</button>${unsaved ? '<button class="btn" data-c="ksave">Salvar</button>' : ''}</footer>`);
}

async function saveKeys(keys) {
  const r = await fetch('keys', keys ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(keys) } : { method: 'DELETE' });
  if (!r.ok) { layer.querySelector('footer')?.insertAdjacentHTML('beforebegin', '<p class="error">Não deu para salvar as teclas. Tente de novo.</p>'); return; }
  s.keys = keys;
  s.unsaved = false;
  list();
}

function next() {
  s.step++;
  s.waitRelease = true;
  s.pending = null;
  if (s.step < STEPS) return drawMap();
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
  s.unsaved = false;
  list();
}

layer.addEventListener('click', async (e) => {
  if (!s) return;
  const el = e.target.closest('[data-c]');
  const a = el?.dataset.c;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  const index = Number(el.dataset.i);
  if (a === 'close' || a === 'scrim') return close();
  if (a === 'list') {
    if (s.unsaved && s.view === 'ktest') s.keys = s.was;
    if (s.unsaved && s.view === 'test') delete s.maps[s.pad];
    s.unsaved = false;
    return list();
  }
  if (a === 'keys') return startKeys();
  if (a === 'ktest') return keyTest(false);
  if (a === 'ksave') return saveKeys(s.keys);
  if (a === 'kforget') return saveKeys(null);
  if (a === 'map') return startMap(index);
  if (a === 'test') return test(pads().find((p) => p.index === index).id);
  if (a === 'skip') {
    if (s.view === 'keys') return nextKey();
    // (a stick not turned can't be pushed: skipping its turn skips the whole stick)
    if (s.step >= 16 && STICKS[s.step - 16].kind === 'turn') {
      s.turn = null;
      s.step += 2;
    }
    return next();
  }
  if (a === 'family') {
    s.family = el.dataset.f;
    return s.view === 'map' ? drawMap() : s.view === 'test' ? test(s.pad, s.unsaved) : list();
  }
  if (a === 'save') return save();
  if (a === 'forget') { delete s.maps[pads().find((p) => p.index === index).id]; await save(); }
  if (a === 'browser') parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*');
});
document.addEventListener('keydown', (e) => {
  if (!s) return;
  if (e.key === 'Escape') { e.stopPropagation(); return close(); }
  // (mapping or testing keys: they're the keys', not the home's nor the focused button's; Tab still moves on)
  if ((s.view !== 'keys' && s.view !== 'ktest') || e.code === 'Tab') return;
  e.preventDefault();
  e.stopPropagation();
  if (s.view === 'ktest') s.held.add(e.code);
  else if (!e.repeat) takeKey(e.code);
}, true);
document.addEventListener('keyup', (e) => {
  if ((s?.view !== 'keys' && s?.view !== 'ktest') || e.code === 'Tab') return;
  e.preventDefault();
  e.stopPropagation();
  s.held?.delete(e.code);
}, true);
window.addEventListener('gamepadconnected', () => { if (s?.view === 'list') list(); });

hooks.controller = async () => {
  s = { view: 'list', maps: {}, family: null, keys: null };
  try { const r = await fetch('pad', { cache: 'no-store' }); if (r.ok) s.maps = await r.json(); } catch (e) {}
  try { const r = await fetch('keys', { cache: 'no-store' }); if (r.ok) s.keys = await r.json(); } catch (e) {}
  list();
  clearInterval(timer);
  timer = setInterval(tick, EVERY_MS);
};
