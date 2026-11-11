// The library: helpers, each game's state as words, the spotlight, the grid of covers, and sending a disc image in
// pieces (resumed where the server stopped). Every address is relative to /p/<pass>/.

export const PIECE = 32 * 1024 * 1024; // under the 100 MB that proxies like Cloudflare take in one request

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n, d = 1) => n.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d });
export const gb = (n) => num(n / 1024 ** 3, 2) + ' GB';
const speed = (bps) => (bps >= 1024 ** 2 ? num(bps / 1024 ** 2) + ' MB/s' : num(bps / 1024, 0) + ' KB/s');
export const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
export const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
export const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;

/** The star that adds a game to the person's favorites (or takes it out): app.js' data-fav. */
export const favButton = (g, on, cls = 'second') =>
  `<button class="btn ${cls} fav${on ? ' on' : ''}" data-fav="${esc(g.key)}" aria-pressed="${on}" aria-label="${on ? 'Tirar dos favoritos' : 'Favoritar'}: ${esc(g.name)}">${icon('star')}${on ? 'Favorito' : 'Favoritar'}</button>`;

function duration(s) {
  if (s < 10) return 'segundos';
  if (s < 60) return `${Math.ceil(s / 5) * 5} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Bytes over time: the speed over the last `span` ms. */
export function meter(span) {
  const samples = [];
  return {
    add(bytes) {
      const t = performance.now();
      samples.push({ t, bytes });
      while (samples.length > 2 && t - samples[0].t > span) samples.shift();
    },
    reset() { samples.length = 0; },
    rate() {
      if (samples.length < 2) return 0;
      const a = samples[0], b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      return dt >= 1 ? Math.max(0, b.bytes - a.bytes) / dt : 0;
    },
  };
}

/** The bar, then how much, how fast and how long. `rate` 0: still measuring (`live`) or not moving. */
export function progress(received, size, rate, live) {
  const p = pct(received, size);
  const left = rate > 0 ? (size - received) / rate : 0;
  const at = rate > 0 ? new Date(Date.now() + left * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<div class="big num"><b>${num(p, 1)}%</b><span>${gb(received)} de ${gb(size)}</span></div>
    <div class="bar${live ? ' moving' : ''}" role="progressbar" aria-label="Envio da ISO" aria-valuemin="0" aria-valuemax="100"
      aria-valuenow="${Math.floor(p)}"><div style="width:${p.toFixed(2)}%"></div></div>
    <div class="stats num">
      <div><b>${rate > 0 ? speed(rate) : '—'}</b><span>velocidade</span></div>
      <div><b>${rate > 0 ? '~' + duration(left) : live ? 'medindo…' : '—'}</b><span>${at ? 'termina ~' + at : 'falta'}</span></div>
    </div>`;
}

/** The state of a game in a few words, and its color. */
export function stateOf(g, sending) {
  const s = g.status;
  if (sending?.key === g.key) return ['busy', `Enviando ${Math.floor(pct(sending.received + sending.inflight, sending.size))}%`];
  switch (s.state) {
    case 'ready': return ['ok', 'Pronto para jogar'];
    case 'empty': return ['warn', 'Precisa da ISO'];
    case 'uploading': return s.mine || s.stale ? ['warn', `Envio parado em ${Math.floor(pct(s.received, s.size))}%`] : ['busy', `Recebendo ${Math.floor(pct(s.received, s.size))}%`];
    default: return ['warn', 'Falta a BIOS']; // needs-bios
  }
}

export const stateBadge = (g, sending) => { const [tone, text] = stateOf(g, sending); return `<span class="state ${tone}">${esc(text)}</span>`; };
export const seal = () => '<span class="seal experimental">Experimental</span>';
/** Can this game take its disc image now (from this window)? */
export const needsDisc = (g, sending) => !sending && (g.status.state === 'empty' || (g.status.state === 'uploading' && (g.status.mine || g.status.stale)));
const free = (g) => g.open.filter((r) => !r.busy);

/** The spotlight's online button: into a friend's open room, else open one. */
function online(g, room) {
  if (room) return `<button class="btn second" data-play="${esc(g.key)}" data-join="${esc(room.code)}">${icon('users')}Entrar como jogador 2</button>`;
  return g.status.state === 'ready' ? `<button class="btn second" data-play="${esc(g.key)}" data-online>${icon('users')}Jogar online</button>` : '';
}

/** `label`: why this game is in the spotlight ("Continuar jogando", "Em destaque"), said under its name; `fav`: starred. */
export function hero(g, sending, label, fav = false) {
  const room = free(g)[0];
  const sub = g.by ? `Adicionado por ${g.by}. A ISO fica no servidor: é só jogar.` : '';
  const play = g.status.state === 'ready'
    ? `<button class="btn" data-play="${esc(g.key)}">${icon('play')}Jogar agora</button>`
    : needsDisc(g, sending) ? `<button class="btn" data-pick="${esc(g.key)}">${icon('upload')}Enviar a ISO</button>` : '';
  return `<h2>${esc(g.name)}</h2>
    <div class="why"><span>${esc(label)}</span>·${seal(g)}${g.status.state === 'ready' ? '' : stateBadge(g, sending)}</div>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
    <div class="actions">${play}${online(g, room)}${favButton(g, fav, 'quiet')}</div>
    ${room ? `<span class="live">${esc(room.host)} está jogando</span>` : ''}`;
}

/**
 * The wall's order and sizes: the spotlight and the games with an open room are big (3 at most, so the first rows
 * show what can be played with someone now; `most`: fewer in a short window); then the person's favorites (`favs`, keys),
 * what needs someone (a missing BIOS, a stopped upload, a failure), what's on its way, and the ready ones by name.
 */
export function arrange(games, top, sending, most = 3, favs = new Set()) {
  const bigs = [top, ...games.filter((g) => g !== top && g.open.length)].filter(Boolean).slice(0, most);
  const rank = (g) => ({ warn: 0, bad: 0, busy: 1 })[stateOf(g, sending)[0]] ?? 2;
  const fav = (g) => (favs.has(g.key) ? 0 : 1);
  const rest = games.filter((g) => !bigs.includes(g))
    .sort((a, b) => fav(a) - fav(b) || rank(a) - rank(b) || (rank(a) === 2 ? a.name.localeCompare(b.name, 'pt-BR') : 0));
  return [...bigs.map((g) => ({ g, big: true })), ...rest.map((g) => ({ g, big: false }))];
}

/** How far it got, for the line on the cover's seam: an upload's bytes. */
function progressOf(g, sending) {
  const s = g.status;
  if (sending?.key === g.key) return pct(sending.received + sending.inflight, sending.size);
  if (s.state === 'uploading') return pct(s.received, s.size);
  return null;
}

/** One cover on the wall, its name and state at its foot. `i`: its place (the first look lights the wall up by it); `fav`: a star on it. */
export function card(g, sending, selected, i, big, fav = false) {
  const [tone, text] = stateOf(g, sending);
  const ready = g.status.state === 'ready' && sending?.key !== g.key;
  const rooms = g.open.length ? `${g.open.length} ${g.open.length === 1 ? 'sala aberta' : 'salas abertas'}` : '';
  const state = ready ? (rooms ? `Pronto · ${rooms}` : 'Pronto') : text;
  const p = progressOf(g, sending);
  return `<article class="card${big ? ' big' : ''}${g.key === selected ? ' on' : ''}" style="--i:${i}">
    <button class="cover" data-open="${esc(g.key)}" aria-label="${esc(g.name)}${fav ? ' (favorito)' : ''}: ${esc(state)}">
      <img src="${esc(g.cover)}" alt="" loading="lazy">${fav ? `<span class="fav-mark">${icon('star')}</span>` : ''}
      <span class="cap"><b>${esc(g.name)}</b>
        <span class="state ${tone}${rooms ? ' live' : ''}"><span>${esc(state)}</span></span>
        ${p === null ? '' : `<i class="seam ${tone}" style="--p:${p.toFixed(1)}%"></i>`}</span>
    </button>
  </article>`;
}

export const installing = (v) => ['resolving', 'downloading', 'extracting'].includes(v?.state);

/** The game coming from vimm.net (server/vimm.ts), like an app installing on a phone: its cover dimmed, a pie filling. */
export function installCard(v, i) {
  const title = v.title || v.name || 'Jogo do vimm.net';
  return `<article class="card installing ${v.state}" style="--i:${i}" data-installing>
    <div class="cover" role="progressbar" aria-label="${esc(title)}" aria-valuemin="0" aria-valuemax="100">
      ${v.cover ? `<img src="${esc(v.cover)}" alt="">` : ''}<span class="pie" aria-hidden="true"></span>
      <span class="cap"><b>${esc(title)}</b><span class="state busy"><span></span></span></span>
    </div>
  </article>`;
}

/** The pie and its words, in place (the wall itself isn't redrawn four times a second). */
export function paintInstall(v) {
  const el = document.querySelector('[data-installing]');
  if (!el || !installing(v)) return;
  const p = v.state === 'extracting' ? 100 : v.state === 'downloading' ? pct(v.received, v.size) : 0;
  el.style.setProperty('--p', `${p.toFixed(1)}%`);
  el.firstElementChild.setAttribute('aria-valuenow', String(Math.floor(p)));
  el.querySelector('.state span').textContent = v.state === 'resolving' ? 'Aguardando…' : v.state === 'extracting' ? 'Instalando…'
    : v.size ? `Baixando ${Math.floor(p)}% · ${gb(v.size)}` : `Baixando ${gb(v.received)}`;
}

/** Two cases in outline that fan out on hover, and a plus. */
export const addCard = (i) => `<button class="add" data-add style="--i:${i}">
    <svg viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke-width="2.5" stroke-linejoin="round">
      <rect class="back" x="14" y="12" width="26" height="38" rx="3" stroke="currentColor"/>
      <rect class="front" x="24" y="14" width="26" height="38" rx="3" stroke="var(--accent)" fill="var(--side)"/>
      <path class="plus" d="M37 27v12M31 33h12" stroke="var(--accent)" stroke-linecap="round"/></g></svg>
    <b>Adicionar jogo</b>
  </button>`;

/** The BIOS of a PS2 (its 4 MB main ROM): the same check the server makes (server/bios.ts), before sending it. */
export async function looksLikeBios(file) {
  if (file.size !== 4 * 1024 * 1024) return false;
  const head = new TextDecoder('latin1').decode(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  for (let at = head.indexOf('RESET\0'); at >= 0; at = head.indexOf('RESET\0', at + 1)) if (head.startsWith('ROMDIR', at + 16)) return true;
  return false;
}

/** Sends the BIOS once for the whole server. Resolves with an error text, or '' when it went in. */
/** `replace`: the server has one already and this one goes in its place. */
export async function sendBios(file, replace = false) {
  if (!(await looksLikeBios(file))) return 'Isso não parece a BIOS de um PS2 (o arquivo de 4 MB do console, .bin ou .ROM0).';
  const r = await fetch(replace ? 'bios?replace=1' : 'bios', { method: 'PUT', body: file });
  if (r.ok || r.status === 409) return '';
  return (await r.json().catch(() => ({}))).error || `Erro ${r.status}`;
}

/** A PUT that reports its bytes as they go (fetch can't). */
function put(url, body, onSent) {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => {
      let json = {};
      try { json = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
      ok({ status: x.status, body: json });
    };
    x.onerror = x.onabort = x.ontimeout = () => fail(new Error('connection'));
    x.send(body);
  });
}

/**
 * Sends `file` as `key`'s disc image, piece by piece, asking the server where it stopped before starting and after
 * every error. `ui`: { start(sending), changed(), expired(), error(text) }. Resolves when it's done or gave up.
 */
export async function upload(key, file, ui) {
  const base = key + '/';
  const sending = { key, size: file.size, received: 0, inflight: 0, meter: meter(8000), retrying: false };
  ui.start(sending);
  for (;;) {
    let at;
    try {
      const r = await fetch(base + 'upload', { cache: 'no-store' });
      if (r.status === 403) return ui.expired();
      at = await r.json();
    } catch (e) {
      await wait(3000);
      continue;
    }
    if (at.done) return;
    let offset = at.size === file.size ? at.received : 0;
    Object.assign(sending, { received: offset, inflight: 0, retrying: false });
    sending.meter.reset();
    sending.meter.add(offset);
    ui.changed();
    let failed = false;
    while (offset < file.size) {
      let res;
      try {
        const from = offset;
        res = await put(`${base}upload?offset=${offset}&size=${file.size}`, file.slice(offset, offset + PIECE), (n) => {
          sending.inflight = n;
          sending.meter.add(from + n);
          ui.changed(true);
        });
      } catch (e) {
        failed = true; // the connection dropped: ask where it stopped and go on from there
        Object.assign(sending, { inflight: 0, retrying: true });
        ui.changed();
        await wait(3000);
        break;
      }
      sending.inflight = 0;
      const { status, body } = res;
      if (status === 403) return ui.expired();
      if (status >= 200 && status < 300) {
        offset = sending.received = body.received;
        ui.changed(true);
        if (body.done) return;
        continue;
      }
      if (body.code === 'order') { failed = true; break; }
      // someone else is sending, the server already has it, it doesn't take this file, or it isn't the game
      if (body.code !== 'done') ui.error(body.error || `Erro ${status}`);
      return;
    }
    if (!failed) return;
  }
}
