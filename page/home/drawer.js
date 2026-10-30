// A game's drawer: its cover and name (editable for the PS2 library), what's happening to it (the disc's upload, the
// build's steps, a failure), the screenshots of the builder's test runs, its open rooms, and what can be done with it.
import { clock, esc, icon, needsDisc, pct, progress, seal, stateBadge } from './library.js';

function steps(g, s) {
  return `<ol class="steps">${Array.from({ length: s.total }, (_, i) => {
    const n = i + 1;
    const name = esc(g.steps[i] ?? `Passo ${n}`);
    if (n < s.step) return `<li class="done">${icon('check')}${name}</li>`;
    if (n === s.step) return `<li class="now">${esc(s.label || name)}</li>`;
    return `<li>${icon('dot')}${name}</li>`;
  }).join('')}</ol>`;
}

function pick(g, label) {
  return `<div class="drop" data-drop="${esc(g.key)}">${icon('upload')}
    <p><strong>Arraste a ISO aqui</strong> ou</p>
    <button class="btn" data-pick="${esc(g.key)}">${esc(label)}</button>
    <p>${esc(g.disc || '')} Basta uma vez: vale para todo mundo.</p></div>`;
}

/** What's happening to the game, and what to do about it. */
function situation(g, ctx) {
  const s = g.status;
  const { sending, watching } = ctx;
  if (sending?.key === g.key) {
    const received = sending.received + sending.inflight;
    return `<p><strong>${sending.retrying ? 'A conexão caiu. Retomando…' : 'Enviando a ISO…'}</strong> Deixe esta janela aberta até terminar.</p>
      ${progress(received, sending.size, sending.retrying ? 0 : sending.meter.rate(), !sending.retrying)}`;
  }
  if (sending && needsDisc(g, null)) return '<p>Outro envio está em andamento nesta janela. Espere ele terminar.</p>';
  switch (s.state) {
    case 'ready':
      return `<p>Tudo pronto: todo mundo já pode jogar.</p><button class="btn wide" data-play="${esc(g.key)}">${icon('play')}Jogar agora</button>`;
    case 'empty':
      return `<p>Ainda sem a ISO. Envie e o servidor compila sozinho.</p>${pick(g, 'Escolher a ISO')}`;
    case 'uploading':
      return s.mine || s.stale
        ? `<p>O envio parou em ${Math.floor(pct(s.received, s.size))}%. Escolha o mesmo arquivo para continuar de onde parou.</p>
           ${progress(s.received, s.size, 0, false)}${pick(g, 'Continuar o envio')}`
        : `<p><strong>${esc(s.by)}</strong> está enviando a ISO.</p>${progress(s.received, s.size, watching.get(g.key)?.rate() ?? 0, true)}`;
    case 'queued':
      return '<div class="busy"><div class="spin"></div><p>ISO recebida. Esperando o compilador começar (um jogo por vez)…</p></div>';
    case 'building':
      return `<p><strong>Compilando o jogo</strong> (passo ${s.step} de ${s.total})</p>
        <div class="bar moving"><div style="width:${pct(s.step - 1, s.total)}%"></div></div>${steps(g, s)}
        <p class="num">Uma vez só. Já passou ${clock(s.elapsed)}.</p>`;
    case 'failed':
      return `<p class="error">${s.refused ? 'O servidor recusou essa ISO.' : 'A compilação falhou.'}</p>
        ${s.reason ? `<p>O jogo parou em: <strong>${esc(s.reason)}</strong></p>` : ''}
        <pre>${esc(s.message || 'Erro desconhecido')}</pre>
        ${s.refused ? pick(g, 'Enviar outra ISO') : `<button class="btn" data-retry="${esc(g.key)}">Tentar de novo</button>`}`;
    default:
      return '<p class="error">O compilador deste jogo não está rodando no servidor.</p><p>Quem cuida do servidor precisa subir o serviço dele.</p>';
  }
}

export function drawer(g, ctx) {
  const recomp = g.kind === 'recomp';
  const name = recomp
    ? `<label class="sr" for="game-name">Nome do jogo</label><input class="field" id="game-name" data-rename="${esc(g.key)}" value="${esc(g.name)}" maxlength="80">`
    : `<p class="name">${esc(g.name)}</p>`;
  const head = `<div class="game-head">
      <img src="${esc(g.cover)}" alt="">
      <div>${name}
        <p>${esc(g.platform)}${g.year ? ' · ' + g.year : ''}${g.serial ? ' · ' + esc(g.serial) : ''}</p>
        ${g.by ? `<p>Adicionado por ${esc(g.by)}</p>` : ''}
        <div class="chips">${seal(g)}${stateBadge(g, ctx.sending)}</div>
      </div>
    </div>`;
  const error = ctx.uploadError.key === g.key && ctx.uploadError.text ? `<p class="error">${esc(ctx.uploadError.text)}</p>` : '';
  const rooms = g.open.length
    ? `<div class="block"><h3>Salas abertas</h3><div class="rooms">${g.open.map((r) => `<div class="room">
        <span><strong>${esc(r.host)}</strong> está jogando</span>
        ${r.busy ? '<span class="state">Cheia</span>' : `<button class="btn small" data-play="${esc(g.key)}" data-join="${esc(r.code)}">${icon('users')}Entrar como jogador 2</button>`}
      </div>`).join('')}</div></div>`
    : '';
  const shots = g.shots
    ? `<div class="block"><h3>Até onde o servidor chegou no jogo</h3>
        <div class="shots">${Array.from({ length: g.shots }, (_, i) => `<img src="${esc(g.key)}/shots/${String(i + 1).padStart(2, '0')}.webp" alt="Captura ${i + 1} dos testes" loading="lazy">`).join('')}</div>
        ${g.note ? `<p>Os testes pararam em: ${esc(g.note)}</p>` : ''}</div>`
    : '';
  const manage = recomp
    ? `<div class="block"><h3>Jogo</h3><div class="row-actions">
        <button class="btn second small" data-cover="${esc(g.key)}">${icon('image')}Trocar capa</button>
        ${g.cover.includes('-c') ? `<button class="btn quiet small" data-cover-remove="${esc(g.key)}">Tirar capa</button>` : ''}
        ${['ready', 'failed'].includes(g.status.state) ? `<button class="btn second small" data-rebuild="${esc(g.key)}">Recompilar</button>` : ''}
        <button class="btn danger small" data-remove="${esc(g.key)}">Remover</button>
      </div><p>Qualquer pessoa pode editar. Remover tira o jogo para todo mundo; os saves ficam guardados.</p></div>`
    : '';
  const warning = recomp
    ? `<p class="note">${icon('warn')} Experimental: compilado a partir da ISO por um projeto que só levou 2 jogos até o fim. Pode travar ou ficar com gráficos quebrados.</p>`
    : '';
  return `${head}<div class="block"><h3>Situação</h3>${situation(g, ctx)}${error}</div>${rooms}${shots}${manage}${warning}`;
}
