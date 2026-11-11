// A game's drawer: its cover (a poster on top) and name (editable for the PS2 library), what's happening to it (the disc's upload,
// a missing BIOS, a failure), a PS2 game's "versão rápida", its open rooms, and what can be done with it.
import { clock, esc, favButton, icon, needsDisc, pct, progress, seal, stateBadge } from './library.js';

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
      return `<p>Ainda sem a ISO. Envie e o jogo fica pronto para todo mundo.</p>${pick(g, 'Escolher a ISO')}`;
    case 'uploading':
      return s.mine || s.stale
        ? `<p>O envio parou em ${Math.floor(pct(s.received, s.size))}%. Escolha o mesmo arquivo para continuar de onde parou.</p>
           ${progress(s.received, s.size, 0, false)}${pick(g, 'Continuar o envio')}`
        : `<p><strong>${esc(s.by)}</strong> está enviando a ISO.</p>${progress(s.received, s.size, watching.get(g.key)?.rate() ?? 0, true)}`;
    default: // needs-bios
      return `<p>A ISO já está no servidor. Falta só a <strong>BIOS do PS2</strong>: o arquivo de 4 MB do seu console, enviado uma vez para o servidor todo.</p>
        <button class="btn" data-bios>${icon('upload')}Enviar a BIOS</button>`;
  }
}

/** A PS2 game's "versão rápida" (ps2-builder/): compiled on request with ps2-web-recomp, much faster where it works. */
function fast(g) {
  const f = g.fast;
  if (!f || g.status.state !== 'ready') return '';
  const key = esc(g.key);
  // (playing, the library's buttons open it: Jogar agora, the rooms; the emulator stays a click away)
  const emulator = `<div class="row-actions"><button class="btn second small" data-play="${key}" data-emulator>${icon('play')}Jogar no emulador</button></div>`;
  let body;
  switch (f.state) {
    case 'off':
      body = `<p>O servidor compila este jogo para o navegador: leva uns 20 a 40 minutos, uma vez para todo mundo. Em jogos pesados fica muito mais rápido que o emulador. Nem todo jogo funciona assim; se não der, o emulador continua aqui.</p>
        <button class="btn second" data-fast-build="${key}">${icon('rocket')}Compilar a versão rápida</button>`;
      break;
    case 'queued':
      body = '<div class="busy"><div class="spin"></div><p>Na fila do compilador (um jogo por vez)…</p></div>';
      break;
    case 'building':
      body = `<p><strong>${f.learning ? 'Aprendendo um trecho novo do jogo' : f.updating ? 'Atualizando a versão rápida' : 'Compilando a versão rápida'}</strong> (passo ${f.step} de ${f.total})</p>
        <div class="bar moving"><div style="width:${pct(f.step - 1, f.total)}%"></div></div>${steps(g, f)}
        <p class="num">${f.playable ? 'A versão de antes continua jogável. ' : 'Uma vez só. '}Já passou ${clock(f.elapsed)}.</p>${f.playable ? emulator : ''}`;
      break;
    case 'ready':
      body = `<p>Pronta: o <strong>Jogar agora</strong> e as salas abrem a versão rápida, com o mesmo save do emulador. Se o jogo chegar num trecho que ela ainda não tem, o servidor tenta compilar esse trecho sozinho.</p>${emulator}`;
      break;
    case 'failed':
      body = `<p class="error">${f.reason ? 'O jogo usa algo que o compilador ainda não sabe fazer.' : 'A versão rápida não compilou.'}</p>
        <pre>${esc(f.reason || f.message || 'Erro desconhecido')}</pre>${f.playable ? '<p>A versão de antes continua jogável no Jogar agora.</p>' : ''}
        <div class="row-actions"><button class="btn" data-fast-build="${key}">Tentar de novo</button>${f.playable ? `<button class="btn second small" data-play="${key}" data-emulator>${icon('play')}Jogar no emulador</button>` : ''}</div>`;
      break;
    default:
      body = '<p class="error">O compilador da versão rápida não está rodando no servidor.</p><p>Quem cuida do servidor precisa subir o serviço ps2-builder.</p>';
  }
  const remove = f.state === 'off' ? '' : `<div class="row-actions"><button class="btn quiet small" data-fast-remove="${key}">Apagar a versão rápida</button></div>`;
  return `<div class="block"><h3>Versão rápida</h3>${body}${remove}</div>`;
}

/** `fav`: the person starred it. */
export function drawer(g, ctx, fav = false) {
  const recomp = g.kind === 'recomp';
  const name = recomp
    ? `<label class="sr" for="game-name">Nome do jogo</label><input class="field" id="game-name" data-rename="${esc(g.key)}" value="${esc(g.name)}" maxlength="80">`
    : `<p class="name">${esc(g.name)}</p>`;
  const head = `<button class="poster" type="button" data-cover="${esc(g.key)}" aria-label="Trocar a capa"><img src="${esc(g.cover)}" alt="">
      <span>${icon('image')}Trocar capa</span></button>
    <div class="game-head">${name}
      <p>${esc(g.platform)}${g.serial ? ' · ' + esc(g.serial) : ''}</p>
      ${g.by ? `<p>Adicionado por ${esc(g.by)}</p>` : ''}
      <div class="chips">${seal(g)}${stateBadge(g, ctx.sending)}</div>
      <div class="row-actions">${favButton(g, fav, 'second small')}</div>
    </div>`;
  const error = ctx.uploadError.key === g.key && ctx.uploadError.text ? `<p class="error">${esc(ctx.uploadError.text)}</p>` : '';
  const rooms = g.open.length
    ? `<div class="rooms">${g.open.map((r) => `<div class="room">
        <span><strong>${esc(r.host)}</strong> está jogando</span>
        <span class="row-actions">${r.busy ? '<span class="state">Jogador 2 ocupado</span>'
          : `<button class="btn small" data-play="${esc(g.key)}" data-join="${esc(r.code)}">${icon('users')}Entrar como jogador 2</button>`}
          <button class="btn second small" data-play="${esc(g.key)}" data-join="${esc(r.code)}" data-watch>${icon('play')}Assistir${r.watchers ? ` (${r.watchers})` : ''}</button></span>
      </div>`).join('')}</div>`
    : '';
  const online = g.status.state === 'ready'
    ? `<div class="block"><h3>Jogar online</h3>${rooms}
        <p>Abra uma sala: um amigo entra por aqui, em <strong>Entrar como jogador 2</strong>, e joga com o controle dele. Os outros podem <strong>Assistir</strong>. Este emulador tem só duas portas de controle: o jogo vai até 2 jogadores.</p>
        <button class="btn second" data-play="${esc(g.key)}" data-online>${icon('users')}Abrir uma sala</button></div>`
    : g.open.length ? `<div class="block"><h3>Salas abertas</h3>${rooms}</div>` : '';
  const manage = `<div class="block"><h3>Jogo</h3><div class="row-actions">
        <button class="btn second small" data-cover="${esc(g.key)}">${icon('image')}Trocar capa</button>
        ${g.cover.includes('-c') ? `<button class="btn quiet small" data-cover-remove="${esc(g.key)}">Tirar capa</button>` : ''}
        ${recomp ? `<button class="btn danger small" data-remove="${esc(g.key)}">Remover</button>` : ''}
      </div><p>${recomp ? 'Qualquer pessoa pode editar. Remover tira o jogo para todo mundo; os saves ficam guardados.' : 'Qualquer pessoa pode trocar a capa: vale para todo mundo.'}</p></div>`;
  const warning = recomp
    ? `<p class="note">${icon('warn')} Em teste: roda no TabStationToo, o PCSX2 no navegador. A maioria dos jogos roda; alguns podem travar, ficar lentos ou com gráficos errados.</p>`
    : '';
  return `${head}<div class="block"><h3>Situação</h3>${situation(g, ctx)}${error}</div>${fast(g)}${online}${manage}${warning}`;
}
