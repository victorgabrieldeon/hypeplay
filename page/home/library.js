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
    case 'queued': return ['busy', 'Na fila'];
    case 'building': return ['busy', `Compilando ${s.step}/${s.total}`];
    case 'failed': return ['bad', s.refused ? 'ISO recusada' : 'Falhou'];
    default: return ['bad', 'Compilador parado'];
  }
}

export const stateBadge = (g, sending) => { const [tone, text] = stateOf(g, sending); return `<span class="state ${tone}">${esc(text)}</span>`; };
export const seal = (g) => g.kind === 'port' ? '<span class="seal tested">Testado</span>' : '<span class="seal experimental">Experimental</span>';
/** Can this game take its disc image now (from this window)? */
export const needsDisc = (g, sending) => !sending && (g.status.state === 'empty' || (g.status.state === 'failed' && g.status.refused) || (g.status.state === 'uploading' && (g.status.mine || g.status.stale)));
const free = (g) => g.open.filter((r) => !r.busy);

export function hero(g, sending) {
  const room = free(g)[0];
  const sub = g.kind === 'port' ? g.blurb : g.by ? `Adicionado por ${g.by}. Compilado pelo servidor a partir da ISO.` : '';
  const play = g.status.state === 'ready'
    ? `<button class="btn" data-play="${esc(g.key)}">${icon('play')}Jogar agora</button>`
    : needsDisc(g, sending) ? `<button class="btn" data-pick="${esc(g.key)}">${icon('upload')}Enviar a ISO</button>` : '';
  return `<div class="backdrop" style="background-image:url('${esc(g.cover)}')"></div>
    <div class="text">
      <div class="chips"><span class="chip">${esc(g.platform)}</span>${seal(g)}${g.tags.filter((t) => t !== 'Experimental').map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <h2>${esc(g.name)}</h2>
      ${sub ? `<p>${esc(sub)}</p>` : ''}
      <div class="actions">${play}<button class="btn second" data-open="${esc(g.key)}">Detalhes</button>${stateBadge(g, sending)}
        ${room ? `<button class="btn second" data-play="${esc(g.key)}" data-join="${esc(room.code)}">${icon('users')}Entrar como jogador 2</button><span class="live">${esc(room.host)} está jogando</span>` : ''}</div>
    </div>
    <img class="case" src="${esc(g.cover)}" alt="">`;
}

export function card(g, sending, selected) {
  return `<article class="card${g.key === selected ? ' on' : ''}">
    <button class="cover" data-open="${esc(g.key)}" aria-label="${esc(g.name)}: ${esc(stateOf(g, sending)[1])}">
      <img src="${esc(g.cover)}" alt="" loading="lazy">
      <span class="pill">${stateBadge(g, sending)}</span>
    </button>
    <h3>${esc(g.name)}</h3>
    <div class="meta">${seal(g)}${g.open.length ? `<span class="state ok">${g.open.length} ${g.open.length === 1 ? 'sala' : 'salas'}</span>` : ''}</div>
  </article>`;
}

export const addCard = () => `<button class="add" data-add>
    <svg aria-hidden="true"><use href="#art-stack"/></svg>
    <b>Adicionar jogo</b><span>Envie a ISO de um jogo de PS2 que você tem</span>
  </button>`;

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
