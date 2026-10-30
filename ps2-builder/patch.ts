/**
 * The ps2-web-recomp page (web/shell.html), adjusted for CordPlay before any game is compiled with it:
 *
 *   - the memory card lives on the server, one per person (GET/PUT ../save), not in the browser's IndexedDB, which the
 *     activity's frame doesn't keep;
 *   - when Discord doesn't isolate the frame, "Abrir no navegador" asks the entry page to open the game outside;
 *   - the online rooms: the server's ICE servers (its TURN relay), no link to copy (friends join from the library),
 *     Portuguese labels, and a guest whose room is gone goes back to the library;
 *   - the browser-support message in Portuguese.
 *
 * Each swap must find its text exactly: a change in the project fails the build here, loudly, instead of shipping a
 * game that saves nowhere. Pinned to the commit in ps2-builder/Dockerfile.
 */

interface Swap {
  from: string;
  to: string;
}

/** Ends the patched page: the builder patches the source copy only once. */
export const MARK = "<!-- cordplay -->";

const STUN = "{ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] }";
const NO_LINK = "Não deu para conectar com o host. Talvez a rede de um dos dois bloqueie; o servidor precisa de um TURN.";

export const SWAPS: Swap[] = [
  {
    from: `        FS.mkdir(CARD_DIR);
        FS.mount(IDBFS, {}, CARD_DIR);
        Module.addRunDependency('card');
        FS.syncfs(true, (err) => {
          if (err) console.warn('memory card: could not read browser storage', err);
          Module.removeRunDependency('card');
        });`,
    to: `        FS.mkdir(CARD_DIR);
        // CordPlay: the card lives on the server, one per person
        Module.addRunDependency('card');
        fetch('../save', { cache: 'no-store' })
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((b) => { if (b) FS.writeFile(CARD_FILE, new Uint8Array(b)); })
          .catch((e) => console.warn('memory card: could not load it from the server', e))
          .finally(() => Module.removeRunDependency('card'));`,
  },
  {
    from: `    try {
      FS.syncfs(false, (err) => {
        if (err) console.warn('memory card: could not write browser storage', err);
        if (then) then();
      });
    } catch (e) {
      if (then) then();
    }`,
    to: `    // CordPlay: the whole card to the server
    let data = null;
    try { data = FS.readFile(CARD_FILE); } catch (e) {}
    if (!data) { if (then) then(); return; }
    fetch('../save', { method: 'PUT', body: data })
      .catch((err) => console.warn('memory card: could not save it on the server', err))
      .finally(() => { if (then) then(); });`,
  },
  {
    from: `if (missing.length) {
  const help = document.getElementById('help');
  help.textContent = 'This browser cannot run the game yet. It lacks ' + missing.join(', ') + '. A current Chrome or Edge has everything it needs.';
  help.hidden = false;
  document.getElementById('start').textContent = 'Unsupported browser';
}`,
    to: `if (missing.length) {
  const help = document.getElementById('help');
  const start = document.getElementById('start');
  if (missing.length === 1 && !window.crossOriginIsolated && window.parent !== window) {
    // CordPlay: Discord didn't isolate this frame; the entry page (it holds the SDK) opens the game in the browser
    help.textContent = 'O Discord não liberou o modo que esse jogo precisa nesta janela. Abra no navegador para jogar.';
    start.textContent = 'Abrir no navegador';
    start.disabled = false;
    start.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*');
    }, true);
  } else {
    help.textContent = 'Este navegador ainda não roda o jogo. Falta: ' + missing.join(', ') + '. Um Chrome ou Edge atualizado tem tudo.';
    start.textContent = 'Navegador sem suporte';
  }
  help.hidden = false;
}`,
  },
  {
    from: `const rtcConfig = ${STUN};`,
    to: `let rtcConfig = ${STUN};
// CordPlay: the server's ICE servers, with its TURN relay when it has one
fetch('ice').then((r) => (r.ok ? r.json() : null)).then((s) => { if (Array.isArray(s)) rtcConfig = { iceServers: s }; }).catch(() => {});`,
  },
  {
    from: `title="Make a room and copy a link that lets a friend watch and play as player 2">Invite</button>`,
    to: `title="Abre uma sala: os amigos entram pela biblioteca do CordPlay como jogador 2">Abrir sala</button>`,
  },
  {
    from: `  const link = inviteLink();
  const copied = navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject(new Error('no clipboard'));
  copied.then(() => note('Invite link copied: ' + link), () => note('Invite link: ' + link));`,
    to: `  // CordPlay: friends join from the library, no link to copy
  note('Sala ' + room + ': os amigos entram pela biblioteca do CordPlay');`,
  },
  { from: `'This server cannot make rooms. Serve the page with scripts/serve.py.'`, to: `'O servidor não abriu a sala. Tente de novo.'` },
  { from: `inviteButton.textContent = 'Room ' + room;`, to: `inviteButton.textContent = 'Sala ' + room;` },
  { from: `inviteButton.title = 'Copy the invite link again';`, to: `inviteButton.title = 'Mostrar o código da sala de novo';` },
  {
    from: `'Room ' + code + ' does not exist any more.' : 'The room server answered ' + r.status + '.'`,
    to: `'A sala ' + code + ' não existe mais.' : 'O servidor de salas respondeu ' + r.status + '.'`,
  },
  { from: `'Joining room ' + guestRoom + '…'`, to: `'Entrando na sala ' + guestRoom + '…'` },
  { from: `'Playing as player 2 in room ' + guestRoom`, to: `'Jogando como jogador 2 na sala ' + guestRoom` },
  { from: `'Could not reach the host. Your networks may need a relay (TURN) server between them.'`, to: `'${NO_LINK}'` },
  { from: `statusEl.textContent = 'Lost the host.';`, to: `statusEl.textContent = 'O host saiu.';` },
  {
    from: `  requestAnimationFrame(send);
  try {
    const messages = roomMessages(guestRoom, id);`,
    to: `  requestAnimationFrame(send);
  // CordPlay: say so when the two can't connect, instead of waiting forever
  setTimeout(() => { if (pc.connectionState !== 'connected') statusEl.textContent = '${NO_LINK}'; }, 15000);
  try {
    const messages = roomMessages(guestRoom, id);`,
  },
  {
    from: `    statusEl.textContent = 'Room ' + guestRoom + ' does not exist any more.';`,
    to: `    statusEl.textContent = 'A sala ' + guestRoom + ' não existe mais.';
    // CordPlay: back to the library
    setTimeout(() => { location.href = '../../../'; }, 4000);`,
  },
  { from: `start.textContent = 'Join room ' + guestRoom;`, to: `start.textContent = 'Entrar na sala ' + guestRoom;` },
  { from: `statusEl.textContent = 'Invited to room ' + guestRoom;`, to: `statusEl.textContent = 'Convidado para a sala ' + guestRoom;` },
];

/** What must be gone afterwards. */
const LEFTOVERS = [/IDBFS/, /FS\.syncfs/, /clipboard\.writeText\(link\)/, />Invite</, /This browser cannot run/];

export function patchShell(html: string): string {
  if (html.includes(MARK)) throw new Error("shell.html: já foi ajustado");
  // (a checkout on Windows has CRLF; the image's has LF)
  let out = html.replace(/\r\n/g, "\n");
  for (const { from, to } of SWAPS) {
    const parts = out.split(from);
    if (parts.length < 2) throw new Error(`shell.html: não achei o trecho ${JSON.stringify(from)} (o ps2-web-recomp mudou? revise ps2-builder/patch.ts)`);
    if (parts.length > 2) throw new Error(`shell.html: o trecho ${JSON.stringify(from)} aparece mais de uma vez`);
    out = parts.join(to);
  }
  for (const re of LEFTOVERS) {
    const m = re.exec(out);
    if (m) throw new Error(`shell.html: sobrou ${JSON.stringify(m[0])}`);
  }
  return `${out.trimEnd()}\n${MARK}\n`;
}
