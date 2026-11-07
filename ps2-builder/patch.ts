/**
 * The ps2-web-recomp page (web/shell.html), adjusted for HypePlay before any game is compiled with it (Emscripten
 * minifies it into each game's ps2web.html, so it can't be adjusted later):
 *
 *   - the memory card lives on the server, one per person (GET/PUT ../save): the same card the emulator's page uses,
 *     with page/cardsync.ts' rules (only "no save yet" starts a blank card; a card that couldn't be read is never
 *     saved over; a save is retried until it goes through; one tab at a time, by the emulator's own Web Lock);
 *   - code the build hasn't translated yet goes to the server (POST miss), which builds it in (ps2-builder/), and the
 *     player is offered the emulator meanwhile;
 *   - when Discord doesn't isolate the frame, "Abrir no navegador" asks the entry page to open the game outside;
 *   - its own online (Invite) is hidden: the library's rooms play through the emulator's page;
 *   - the messages a player meets, in Portuguese.
 *
 * Each swap must find its text exactly: a change in the project fails the build here, loudly, instead of shipping a
 * game that saves nowhere. Pinned to the commit in ps2-builder/Dockerfile.
 */

interface Swap {
  from: string;
  to: string;
}

/** Ends the patched page: the builder patches the source copy only once. */
export const MARK = "<!-- hypeplay -->";

export const SWAPS: Swap[] = [
  {
    from: `let cardTimer = 0;
function storeCard(then) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    try {
      FS.syncfs(false, (err) => {
        if (err) console.warn('memory card: could not write browser storage', err);
        if (then) then();
      });
    } catch (e) {
      if (then) then();
    }
  }, 300);
}`,
    to: `let cardTimer = 0;
// HypePlay: the memory card lives on the server, one per person and game (../save), the same card the emulator's page
// uses. Saving stays off when the server's copy couldn't be read or another tab holds the cards: a blank or stale card
// must never go over the real one. A save is retried until it goes through, and the page asks before closing meanwhile.
let cardSaving = false, cardSending = null, cardAgain = false;
const cardHold = (e) => { e.preventDefault(); e.returnValue = ''; };
const cardWait = (ms) => new Promise((ok) => setTimeout(ok, ms));
function cardWarn(text) {
  const help = document.getElementById('help');
  if (help) { help.textContent = text; help.hidden = false; } else note(text);
}
// (the emulator's page keeps its unsent card per game, page/ps2play.ts: this game's is the one to send)
const cardUnsent = 'cordplay-unsent:' + location.pathname.split('/fast/')[0].split('/').pop();
async function cardLoad() {
  const mine = !navigator.locks || await new Promise((ok) => {
    navigator.locks.request('tabstationtoo-memcards', { ifAvailable: true }, (lock) => { ok(!!lock); return lock ? new Promise(() => {}) : null; }).catch(() => ok(true));
  });
  if (!mine) return cardWarn('Este jogo já está aberto em outra aba: o que você salvar aqui não vai para o servidor. Feche a outra e abra de novo.');
  // A card the emulator's page left unsent (closed mid-upload, page/cardsync.ts) goes up first, or it would later go
  // over what is saved here. Its database is only read: one that isn't there yet isn't made.
  const unsent = await new Promise((ok) => {
    try {
      const open = indexedDB.open('pcsx2-web-cards', 1);
      open.onupgradeneeded = () => open.transaction.abort();
      open.onerror = () => ok(null);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const get = db.transaction('meta', 'readonly').objectStore('meta').get(cardUnsent);
          get.onsuccess = () => ok({ db, bytes: get.result instanceof Uint8Array && get.result.length === CARD_BYTES ? get.result : null });
          get.onerror = () => ok({ db, bytes: null });
        } catch (e) { ok({ db, bytes: null }); }
      };
    } catch (e) { ok(null); }
  });
  if (unsent && unsent.bytes) {
    const r = await fetch('../save', { method: 'PUT', body: unsent.bytes }).catch(() => null);
    if (!r || !r.ok) {
      unsent.db.close();
      return cardWarn('Um save do emulador ainda não chegou no servidor. Abra o jogo no emulador para ele terminar de enviar; até lá, o que você salvar aqui não vai para o servidor.');
    }
    try { unsent.db.transaction('meta', 'readwrite').objectStore('meta').delete(cardUnsent); } catch (e) {}
  }
  if (unsent) unsent.db.close();
  for (const wait of [0, 2000, 5000]) {
    await cardWait(wait);
    const r = await fetch('../save', { cache: 'no-store' }).catch(() => null);
    if (r && r.status === 404) { cardSaving = true; return; }
    if (r && r.ok) {
      try { FS.writeFile(CARD_FILE, new Uint8Array(await r.arrayBuffer())); cardSaving = true; return; } catch (e) {}
    }
  }
  cardWarn('Não deu para buscar o seu save no servidor agora. Dá para jogar, mas o que você salvar nesta vez não vai para o servidor.');
}
function cardSend() {
  if (!cardSaving) return Promise.resolve();
  cardAgain = true;
  if (cardSending) return cardSending;
  addEventListener('beforeunload', cardHold);
  cardSending = (async () => {
    while (cardAgain) {
      cardAgain = false;
      let data = null;
      try { data = FS.readFile(CARD_FILE); } catch (e) {}
      if (!data) break;
      for (let tries = 0; ; tries++) {
        const r = await fetch('../save', { method: 'PUT', body: data }).catch(() => null);
        // (400/413: the server says it isn't a card; sending it again won't change that)
        if (r && (r.ok || r.status === 400 || r.status === 413)) break;
        if (tries === 1) note('O save ainda não chegou no servidor. Tentando de novo…');
        await cardWait([2000, 5000, 15000, 30000][Math.min(tries, 3)]);
      }
    }
  })().finally(() => { cardSending = null; removeEventListener('beforeunload', cardHold); });
  return cardSending;
}
function storeCard(then) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => { cardSend().finally(() => { if (then) then(); }); }, 300);
}`,
  },
  {
    from: `        FS.mkdir(CARD_DIR);
        FS.mount(IDBFS, {}, CARD_DIR);
        Module.addRunDependency('card');
        FS.syncfs(true, (err) => {
          if (err) console.warn('memory card: could not read browser storage', err);
          Module.removeRunDependency('card');
        });`,
    to: `        FS.mkdir(CARD_DIR);
        // HypePlay: the card from the server (cardLoad); only "no save yet" starts a blank one
        Module.addRunDependency('card');
        cardLoad().finally(() => Module.removeRunDependency('card'));`,
  },
  {
    from: `    statusEl.textContent = 'Halted: ' + reason;
    statusEl.style.color = '#f66';`,
    to: `    // HypePlay: code this build hasn't translated yet goes to the server, which builds it in (ps2-builder)
    const miss = /missing code at 0x([0-9A-F]{8})/.exec(reason);
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:rgb(11 10 20 / .92);z-index:10;text-align:center';
    box.innerHTML = '<div style="max-width:460px;display:grid;gap:12px"><p style="margin:0;font-size:15px;line-height:24px"></p><a href="../game/" style="color:#a08cff">Continuar no emulador</a></div>';
    const say = (taken) => {
      box.querySelector('p').textContent = taken
        ? 'O jogo chegou num trecho que a versão rápida ainda não tem. O servidor vai tentar compilar esse trecho: abra de novo pela biblioteca daqui a alguns minutos. Até lá, dá para continuar no emulador, com o mesmo save.'
        : (miss ? 'O jogo chegou num trecho que a versão rápida não tem.' : 'O jogo parou (' + reason + ').') + ' Dá para continuar no emulador, com o mesmo save.';
    };
    say(false);
    // (only a pc the server took is promised; one it turned down stays with the emulator)
    if (miss) fetch('miss', { method: 'POST', body: miss[1] }).then((r) => say(r.ok), () => {});
    document.body.appendChild(box);
    statusEl.textContent = 'Parou';`,
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
    // HypePlay: Discord didn't isolate this frame; the entry page (it holds the SDK) opens the game in the browser
    help.textContent = 'O Discord não liberou o modo que esse jogo precisa nesta janela. Abra no navegador para jogar.';
    start.textContent = 'Abrir no navegador';
    start.disabled = false;
    start.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*');
    }, true);
  } else {
    help.textContent = 'Este navegador ainda não roda o jogo. Falta: ' + missing.join(', ') + '. Um Chrome, Edge ou Firefox atualizado tem tudo (no Linux, com o WebGPU ligado).';
    start.textContent = 'Navegador sem suporte';
  }
  help.hidden = false;
}`,
  },
  {
    from: `<button id="invite" class="host-only" type="button" disabled title="Make a room and copy a link that lets a friend watch and play as player 2">Invite</button>`,
    to: `<button id="invite" class="host-only" type="button" disabled hidden style="display:none">Convidar</button>`,
  },
  { from: `<span id="status">Loading…</span>`, to: `<span id="status">Carregando…</span>` },
  { from: `<button id="start" disabled>Loading…</button>`, to: `<button id="start" disabled>Carregando…</button>` },
  { from: `    start.textContent = 'Start';`, to: `    start.textContent = 'Jogar';` },
  { from: `statusEl.textContent = 'Running, ' + Module.gpuInfo;`, to: `statusEl.textContent = 'Rodando, ' + Module.gpuInfo;` },
];

/** What must be gone afterwards. */
const LEFTOVERS = [/IDBFS/, /FS\.syncfs/, />Invite</, /This browser cannot run/, /'Halted: '/];

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
