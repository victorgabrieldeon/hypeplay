// "Adicionar jogo": a PS2 game into the library, once, for everyone. The warning first (only with "Entendi"); the
// PS2 BIOS when the server has none yet (once for the whole server); then the disc image, whose serial is read here
// (iso.js) so a game already in the library is never sent again; then its name and cover. Sending is the library's
// own upload, in the game's drawer; once the image is in, the game plays.
import { gameOf, hooks, poll, send, state } from './app.js';
import { esc, gb, icon, sendBios } from './library.js';

const layer = document.getElementById('layer');
const BT3_SERIAL = 'SLUS-21678';
const NAMES = { warn: 'Aviso', bios: 'BIOS', iso: 'ISO', name: 'Nome e capa' };

let w = null; // { step, steps, ok, file, serial, name, cover, coverUrl, error, busy, exists }
let returnFocus = null;

function close() {
  if (w?.coverUrl) URL.revokeObjectURL(w.coverUrl);
  w = null;
  layer.innerHTML = '';
  returnFocus?.focus?.({ preventScroll: true });
}

const steps = () => `<ol class="chips" aria-label="Passos">${w.steps
  .map((s, i) => `<li class="chip" ${s === w.step ? 'aria-current="step" style="background:var(--primary);color:#fff"' : ''}>${i + 1}. ${NAMES[s]}</li>`).join('')}</ol>`;

function go(delta) {
  const i = w.steps.indexOf(w.step) + delta;
  Object.assign(w, { step: w.steps[Math.max(0, Math.min(i, w.steps.length - 1))], error: '', exists: null });
  render();
}

function body() {
  if (w.step === 'warn')
    return `${steps()}
      <p style="display:flex;gap:var(--s3)"><span style="color:var(--warn)">${icon('warn')}</span><span>Os jogos de PS2 rodam no
      TabStationToo, o emulador PCSX2 no navegador, ainda em teste. A maioria dos jogos roda; alguns podem travar, ficar lentos ou
      com gráficos errados. Precisa de um Chrome ou Edge atualizado e de um PC razoável. A ISO fica guardada no servidor: você
      envia uma vez e todo mundo joga quando quiser. Use só a ISO de um jogo que você tem.</span></p>
      <label style="display:flex;gap:var(--s2);align-items:center;cursor:pointer"><input type="checkbox" id="w-ok"${w.ok ? ' checked' : ''}> Entendi</label>
      <footer><button class="btn quiet" data-w="cancel">Cancelar</button><button class="btn" data-w="next"${w.ok ? '' : ' disabled'}>Continuar</button></footer>`;
  if (w.step === 'bios')
    return `${steps()}
      <p>Este servidor ainda não tem a <strong>BIOS do PS2</strong>. É o arquivo de 4 MB tirado do seu console (<code>.bin</code> ou
      <code>.ROM0</code>). Basta uma vez: depois ninguém mais precisa enviar.</p>
      <div class="drop" data-wdrop="bios">${icon('upload')}<p><strong>Arraste a BIOS aqui</strong> ou</p>
        <button class="btn" data-w="pickbios">Escolher a BIOS</button></div>
      ${w.busy ? '<div class="busy"><div class="spin"></div><p>Enviando a BIOS…</p></div>' : ''}
      ${w.error ? `<p class="error">${esc(w.error)}</p>` : ''}
      <footer><button class="btn quiet" data-w="back">Voltar</button></footer>`;
  if (w.step === 'iso') {
    const existing = w.exists && gameOf(w.exists);
    return `${steps()}
      <div class="drop" data-wdrop="iso">${icon('upload')}<p><strong>Arraste a ISO aqui</strong> ou</p>
        <button class="btn" data-w="pick">Escolher a ISO</button><p>Um disco de PS2 (.iso). Fica no servidor para todo mundo.</p></div>
      ${w.busy ? '<div class="busy"><div class="spin"></div><p>Lendo o disco…</p></div>' : ''}
      ${w.error ? `<p class="error">${esc(w.error)}</p>` : ''}
      ${existing ? `<p><strong>${esc(existing.name)}</strong> já está na biblioteca. Não precisa enviar de novo.</p>
        <button class="btn" data-w="play">${icon('play')}Jogar</button>` : ''}
      <footer><button class="btn quiet" data-w="back">Voltar</button></footer>`;
  }
  return `${steps()}
    <div class="game-head"><img src="${esc(w.coverUrl || 'cover/bt3')}" alt="" style="${w.coverUrl ? '' : 'opacity:.35'}">
      <div class="block">
        <label for="w-name">Nome do jogo</label>
        <input class="field" id="w-name" maxlength="80" value="${esc(w.name)}">
        <p>${esc(w.serial)} · ${gb(w.file.size)}</p>
      </div></div>
    <div class="row-actions"><button class="btn second small" data-w="cover">${icon('image')}${w.cover ? 'Trocar a capa' : 'Escolher uma capa (opcional)'}</button>
      ${w.cover ? '<button class="btn quiet small" data-w="nocover">Sem capa</button>' : ''}</div>
    <p class="note">PNG, JPG ou WebP até 5 MB, recortada em 2:3. Sem capa, o servidor desenha uma.</p>
    ${w.error ? `<p class="error">${esc(w.error)}</p>` : ''}
    <footer><button class="btn quiet" data-w="back">Voltar</button><button class="btn" data-w="send"${w.busy ? ' disabled' : ''}>${icon('upload')}Enviar</button></footer>`;
}

function render() {
  if (!w) return;
  const focused = document.activeElement?.id;
  layer.innerHTML = `<div class="modal" data-w="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="w-title">
    <header><h2 id="w-title">Adicionar jogo</h2><button class="btn quiet" data-w="cancel" aria-label="Fechar">${icon('close')}</button></header>
    ${body()}</div></div>`;
  const keep = focused && document.getElementById(focused);
  (keep || layer.querySelector('.dialog button:not([disabled]):not([aria-label]), .dialog input, .dialog button'))?.focus();
}

async function chooseBios(file) {
  Object.assign(w, { error: '', busy: true });
  render();
  const error = await sendBios(file);
  Object.assign(w, { busy: false, error });
  if (!error) {
    w.steps = w.steps.filter((s) => s !== 'bios');
    w.step = 'iso';
  }
  render();
}

async function chooseDisc(file) {
  Object.assign(w, { error: '', exists: null, busy: true });
  render();
  const id = await globalThis.CordISO.fromFile(file).catch(() => null);
  w.busy = false;
  if (!id) {
    w.error = 'Isso não parece um disco de PS2 (não achei o SYSTEM.CNF com o jogo).';
    return render();
  }
  const exists = id.serial === BT3_SERIAL ? 'bt3' : state.games?.find((g) => g.serial === id.serial)?.key;
  if (exists) {
    w.exists = exists;
    return render();
  }
  Object.assign(w, { file, serial: id.serial, name: w.name || id.serial, step: 'name' });
  render();
}

function pick(accept, then) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener('change', () => input.files[0] && then(input.files[0]));
  input.click();
}

async function submit() {
  w.name = document.getElementById('w-name').value.trim() || w.serial;
  Object.assign(w, { busy: true, error: '' });
  render();
  const r = await fetch('ps2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serial: w.serial, name: w.name }) });
  const res = await r.json().catch(() => ({}));
  if (r.status === 409) {
    await poll();
    // (a game someone else is adding right now isn't in the library yet)
    if (!gameOf(res.exists)) Object.assign(w, { busy: false, error: 'Alguém está adicionando esse jogo agora. Tente de novo daqui a pouco.' });
    else Object.assign(w, { step: 'iso', busy: false, exists: res.exists });
    return render();
  }
  if (!r.ok) {
    Object.assign(w, { busy: false, error: res.error || `Erro ${r.status}` });
    return render();
  }
  if (w.cover) await fetch(`${res.key}/cover`, { method: 'PUT', body: w.cover }).catch(() => {});
  const file = w.file;
  close();
  await poll();
  send(res.key, file);
}

layer.addEventListener('click', (e) => {
  if (!w) return;
  const el = e.target.closest('[data-w]');
  const a = el?.dataset.w;
  if (!a || (a === 'scrim' && e.target !== el)) return;
  if (a === 'cancel' || a === 'scrim') return close();
  if (a === 'next') return go(1);
  if (a === 'back') return go(-1);
  if (a === 'pickbios') return pick('.bin,.rom0,.ROM0,application/octet-stream', chooseBios);
  if (a === 'pick') return pick('.iso,.bin,.img', chooseDisc);
  if (a === 'play') { const g = gameOf(w.exists); close(); if (g) hooks.play(g); return; }
  if (a === 'cover') return pick('image/png,image/jpeg,image/webp', (f) => {
    if (f.size > 5 * 1024 ** 2) { w.error = 'A capa pode ter até 5 MB.'; return render(); }
    if (w.coverUrl) URL.revokeObjectURL(w.coverUrl);
    Object.assign(w, { cover: f, coverUrl: URL.createObjectURL(f), error: '', name: document.getElementById('w-name')?.value ?? w.name });
    render();
  });
  if (a === 'nocover') { URL.revokeObjectURL(w.coverUrl); Object.assign(w, { cover: null, coverUrl: null }); return render(); }
  if (a === 'send') return submit();
});
layer.addEventListener('change', (e) => {
  if (w && e.target.id === 'w-ok') { w.ok = e.target.checked; render(); }
});
layer.addEventListener('dragover', (e) => { const d = w && e.target.closest('[data-wdrop]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
layer.addEventListener('drop', (e) => {
  const d = w && e.target.closest('[data-wdrop]');
  if (!d) return;
  e.preventDefault();
  e.stopPropagation();
  const f = e.dataTransfer.files[0];
  if (f) (d.dataset.wdrop === 'bios' ? chooseBios : chooseDisc)(f);
});
document.addEventListener('keydown', (e) => {
  if (!w) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
  // (focus stays in the dialog)
  if (e.key === 'Tab') {
    const all = [...layer.querySelectorAll('button:not([disabled]), input')];
    const i = all.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); all.at(-1)?.focus(); }
    else if (!e.shiftKey && i === all.length - 1) { e.preventDefault(); all[0]?.focus(); }
  }
}, true);

hooks.add = async () => {
  returnFocus = document.activeElement;
  const bios = await fetch('bios', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { present: true })).catch(() => ({ present: true }));
  const flow = bios.present ? ['warn', 'iso', 'name'] : ['warn', 'bios', 'iso', 'name'];
  w = { step: 'warn', steps: flow, ok: false, file: null, serial: '', name: '', cover: null, coverUrl: null, error: '', busy: false, exists: null };
  render();
};
