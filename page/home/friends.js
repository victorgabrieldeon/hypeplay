// Friends (server/social.ts), drawn in the words' column in place of "Pessoas": invites and requests on top, then the
// friends playing, online and offline, then who else is around to add. A friend's name or avatar opens their profile
// (hours per game, recent sessions, badges, games in common); "Convidar" picks a game and sends the invite (with the room
// when you host one). "Amigos" in the bar opens its own screen (#amigos): the whole list, your status and note, adding
// someone by name, what was sent, and the friends' activity. In a game, Shift+Tab opens them (overlay.ts). Toasts say when a friend comes online, starts a game, invites you or takes your invite.
import { gameOf, hooks, person, poll, set, state } from './app.js';
import { ask } from './ask.js';
import { esc, icon, initials } from './library.js';

const $ = (id) => document.getElementById(id);
const layer = $('layer');

const STATUS = { online: 'Online', away: 'Ausente', busy: 'Não perturbe', invisible: 'Invisível', offline: 'Offline' };
/** state = shape + text (DESIGN.md): online ●, away ◆, busy ■, offline (no mark) */
const SHAPE = { online: 'ok', away: 'warn', busy: 'bad', invisible: '', offline: '' };

const api = (path, init) => fetch(path, init).then((r) => { if (r.status === 403) state.expired = true; return r; });
const send = (path, method, body) => api(path, { method, keepalive: true, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });

/** An avatar: the initials on a colour from the id (the same person, the same colour everywhere). */
function avatar(id, name, big = false) {
  let h = 7;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 3607;
  h = (h * 137) % 360;
  return `<div class="avatar f${big ? ' huge' : ''}" style="--h:${h}" aria-hidden="true">${esc(initials(name))}</div>`;
}

export function ago(t) {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `há ${d} ${d === 1 ? 'dia' : 'dias'}` : `há ${Math.round(d / 30)} ${Math.round(d / 30) === 1 ? 'mês' : 'meses'}`;
}

/** A session: how long and when; "jogando agora" while its game still beats. */
const when = (s) => (Date.now() - s.end < 60_000 ? `jogando agora${s.end - s.start >= 60_000 ? ` · ${hours(s.end - s.start)}` : ''}` : `${hours(s.end - s.start)} · ${ago(s.end)}`);

export function hours(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))} min`;
  return `${h.toLocaleString('pt-BR', { maximumFractionDigits: h < 10 ? 1 : 0 })} h`;
}

const around = (id) => state.people.find((p) => p.id === id);
const avBtn = (id, name) => `<button type="button" class="av" data-f-profile="${esc(id)}" aria-label="Ver o perfil de ${esc(name)}">${avatar(id, name)}</button>`;
const profileBtn = (id, name) => `<button type="button" class="name" data-f-profile="${esc(id)}" title="Ver o perfil de ${esc(name)}">${esc(name)}</button>`;

/** One friend: playing (with their room), online, away, busy or offline ("visto há 3 h"). */
function friend(f) {
  const p = around(f.id);
  const room = p?.room && gameOf(p.room.key) ? p.room : null;
  const title = p?.game?.title ?? (room && gameOf(room.key).name);
  const on = f.status !== 'offline';
  const doing = !on ? (f.seen ? `Visto ${ago(f.seen)}` : 'Offline')
    : p?.game?.watch ? `Assistindo ${title}`
    : title ? `Jogando ${title}${p?.game ? ` · ${ago(p.game.at).replace('há ', '')}` : ''}`
    : STATUS[f.status];
  const cls = title && on ? 'ok live' : SHAPE[f.status];
  const join = (label, watch) =>
    `<button class="btn ${watch ? 'second ' : ''}small" data-play="${esc(room.key)}" data-join="${esc(room.code)}"${watch ? ' data-watch' : ''} aria-label="${esc(`${label} na sala de ${f.name}`)}">${icon(watch ? 'play' : 'users')}${label}</button>`;
  const acts = room ? (room.busy ? '' : join('Entrar', false)) + join('Assistir', true)
    : on && f.status !== 'busy' ? `<button class="btn quiet small" data-f-invite="${esc(f.id)}" aria-label="Convidar ${esc(f.name)} para jogar">${icon('rocket')}</button>` : '';
  return `<div class="person${on ? '' : ' off'}">${avBtn(f.id, f.name)}
    <div class="who"><b>${profileBtn(f.id, f.name)}${p?.call ? '<span class="tag">NA CALL</span>' : ''}</b>
      <span class="state ${cls}">${esc(doing)}</span>${f.note && on ? `<small>“${esc(f.note)}”</small>` : ''}</div>
    ${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
}

function invite(i) {
  const g = gameOf(i.key);
  if (i.kind === 'accepted')
    return `<div class="notice">${icon('check')}<p><b>${esc(i.name)}</b> aceitou jogar ${esc(i.title)}. Quando a sala abrir, ela aparece na sua lista para entrar.</p>
      <button class="btn quiet small" data-f-answer="${esc(i.id)}" aria-label="Dispensar">${icon('close')}</button></div>`;
  // with a room: joining it; without: opening the game with a room of mine, which shows in their list to join
  const go = !g ? '' : i.code
    ? `<button class="btn small" data-f-answer="${esc(i.id)}" data-f-accept data-play="${esc(i.key)}" data-join="${esc(i.code)}">${icon('users')}Entrar na sala</button>`
    : `<button class="btn small" data-f-answer="${esc(i.id)}" data-f-accept data-play="${esc(i.key)}" data-online>${icon('play')}Abrir sala</button>`;
  return `<div class="notice invite">${g ? `<img src="${esc(g.cover)}" alt="">` : ''}<p><b>${esc(i.name)}</b> te chamou para jogar <b>${esc(i.title)}</b>${i.code ? ` <span class="serial">${esc(i.code)}</span>` : ''}</p>
    <div class="acts">${go}<button class="btn quiet small" data-f-answer="${esc(i.id)}">Recusar</button></div></div>`;
}

function request(r) {
  return `<div class="person">${avBtn(r.id, r.name)}<div class="who"><b>${profileBtn(r.id, r.name)}</b><span class="state">Pediu amizade</span></div>
    <div class="acts"><button class="btn small" data-f-add="${esc(r.id)}">Aceitar</button><button class="btn quiet small" data-f-remove="${esc(r.id)}" aria-label="Recusar o pedido de ${esc(r.name)}">${icon('close')}</button></div></div>`;
}

const group = (title, items) => (items.length ? `<h3 class="f-group">${esc(title)} <span class="num">${items.length}</span></h3>${items.join('')}` : '');

let showOffline = false;

/** Invites, requests, then the friends playing, online and offline, then who else is around. */
function listHtml(s, offlineOpen) {
  const ids = new Set(s.friends.map((f) => f.id));
  const playing = [], online = [], offline = [];
  for (const f of s.friends) {
    const p = around(f.id);
    (f.status === 'offline' ? offline : p?.game || p?.room ? playing : online).push(f);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  offline.sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0));
  const near = state.people.filter((p) => !ids.has(p.id));
  const sent = new Set(s.outgoing.map((o) => o.id));
  const asked = new Set(s.incoming.map((o) => o.id));
  const nearRow = (p) => person(p, sent.has(p.id) ? '<span class="tag sent">PEDIDO ENVIADO</span>' : asked.has(p.id) ? ''
    : `<button class="btn quiet small" data-f-add="${esc(p.id)}" aria-label="Adicionar ${esc(p.name)} à sua lista de amigos">${icon('plus')}</button>`, profileBtn(p.id, p.name));
  return [
    s.invites.map(invite).join(''),
    group('Pedidos', s.incoming.map(request)),
    group('Jogando', playing.sort(byName).map(friend)),
    group('Online', online.sort(byName).map(friend)),
    offline.length ? `<h3 class="f-group">Offline <span class="num">${offline.length}</span>${page.hidden ? ` <button type="button" class="link" data-f-offline>${offlineOpen ? 'esconder' : 'mostrar'}</button>` : ''}</h3>${offlineOpen ? offline.map(friend).join('') : ''}` : '',
    group('Por perto', near.map(nearRow)),
    !s.friends.length && !near.length && !s.incoming.length ? `<p class="f-empty">Adicione quem joga com você para ver o que estão jogando e chamar para uma partida.</p>` : '',
  ].join('');
}

const liveCount = (s) => s.friends.filter((f) => f.status !== 'offline').length;

function renderFriends() {
  const s = state.social;
  if (!s) return hooks.peopleFallback();
  const live = liveCount(s);
  $('people').hidden = false;
  document.querySelector('[data-nav="people"]').hidden = false;
  set($('people-title'), 'Amigos');
  set($('n-people'), live ? String(live) : '');
  set($('people-sub'), `${s.friends.length ? `${live} de ${s.friends.length} online` : 'Ninguém ainda'} · <button type="button" class="link" data-f-manage>${s.incoming.length ? `${s.incoming.length} ${s.incoming.length === 1 ? 'pedido' : 'pedidos'}` : 'Adicionar'}</button>`);
  if (page.hidden) set($('people-list'), listHtml(s, showOffline));
  renderPage();
  notify(s);
}

// ---- toasts: what changed between two polls ----
let before = null;
function toast(html, ms = 6000) {
  let box = $('toasts');
  if (!box) {
    box = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toasts' }));
    box.setAttribute('aria-live', 'polite');
  }
  const el = Object.assign(document.createElement('div'), { className: 'toast', innerHTML: html });
  box.append(el);
  setTimeout(() => el.remove(), ms);
}
function notify(s) {
  const now = { friends: new Map(s.friends.map((f) => [f.id, { on: f.status !== 'offline', game: around(f.id)?.game?.key ?? null }])), invites: new Set(s.invites.map((i) => i.id)), incoming: new Set(s.incoming.map((r) => r.id)) };
  if (before) {
    for (const f of s.friends) {
      const was = before.friends.get(f.id), is = now.friends.get(f.id);
      if (!was) toast(`${avatar(f.id, f.name)}<p><b>${esc(f.name)}</b> e você agora são amigos</p>`);
      else if (is.game && is.game !== was.game) toast(`${avatar(f.id, f.name)}<p><b>${esc(f.name)}</b> começou a jogar ${esc(around(f.id).game.title)}</p>`);
      else if (is.on && !was.on) toast(`${avatar(f.id, f.name)}<p><b>${esc(f.name)}</b> ficou online</p>`);
    }
    for (const i of s.invites) if (!before.invites.has(i.id)) toast(`${avatar(i.from, i.name)}<p>${i.kind === 'accepted' ? `<b>${esc(i.name)}</b> aceitou seu convite para ${esc(i.title)}` : `<b>${esc(i.name)}</b> te chamou para jogar ${esc(i.title)}`}</p>`, 10_000);
    for (const r of s.incoming) if (!before.incoming.has(r.id)) toast(`${avatar(r.id, r.name)}<p><b>${esc(r.name)}</b> pediu amizade</p>`);
  }
  before = now;
}

// ---- the profile ----
function bar(ms, most) {
  return `<span class="hbar"><i style="width:${most ? Math.max(2, (ms / most) * 100) : 0}%"></i></span>`;
}
function profileHtml(p) {
  const g0 = p.games[0]?.ms ?? 0;
  const cover = (key) => { const g = gameOf(key); return g ? `<img src="${esc(g.cover)}" alt="" loading="lazy">` : '<span class="nocover"></span>'; };
  const rel = {
    self: '',
    friend: `<button class="btn small" data-f-invite="${esc(p.id)}">${icon('rocket')}Convidar para jogar</button><button class="btn quiet small" data-f-unfriend="${esc(p.id)}">Desfazer amizade</button>`,
    incoming: `<button class="btn small" data-f-add="${esc(p.id)}">Aceitar pedido</button><button class="btn quiet small" data-f-remove="${esc(p.id)}">Recusar</button>`,
    outgoing: `<span class="state busy">Pedido enviado</span><button class="btn quiet small" data-f-remove="${esc(p.id)}">Cancelar</button>`,
    none: `<button class="btn small" data-f-add="${esc(p.id)}">${icon('plus')}Adicionar amigo</button>`,
  }[p.relation];
  const room = around(p.id)?.room;
  const playing = around(p.id)?.game;
  const status = playing && p.status !== 'offline' ? `<span class="state ok live">Jogando ${esc(playing.title)}</span>`
    : `<span class="state ${SHAPE[p.status]}">${esc(p.status === 'offline' && p.seen ? `Visto ${ago(p.seen)}` : STATUS[p.status])}</span>`;
  const stat = (n, label) => `<div class="pf-stat"><b class="num">${n}</b><span>${label}</span></div>`;
  const since = new Date(p.since).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
  return `<div class="modal" data-f="scrim"><div class="dialog wide profile" role="dialog" aria-modal="true" aria-labelledby="pf-name">
    <header>${avatar(p.id, p.name, true)}<div class="pf-who"><h2 id="pf-name">${esc(p.name)}</h2>${status}${p.note ? `<p class="pf-note">“${esc(p.note)}”</p>` : ''}</div>
      <button class="btn quiet" data-f="close" aria-label="Fechar">${icon('close')}</button></header>
    ${rel || room ? `<div class="pf-acts">${room && gameOf(room.key) ? `<button class="btn small" data-play="${esc(room.key)}" data-join="${esc(room.code)}"${room.busy ? ' data-watch' : ''}>${icon(room.busy ? 'play' : 'users')}${room.busy ? 'Assistir' : 'Entrar na sala'}</button>` : ''}${rel}</div>` : ''}
    <div class="pf-stats">${stat(hours(p.total), 'jogadas')}${stat(p.games.length, p.games.length === 1 ? 'jogo' : 'jogos')}${stat(p.friends, p.friends === 1 ? 'amigo' : 'amigos')}${stat(esc(since), 'desde')}</div>
    ${p.badges.length ? `<section><h3>Conquistas</h3><div class="badges">${p.badges.map((b) => `<span class="badge" title="${esc(b.text)}"><i class="b-${esc(b.id)}" aria-hidden="true"></i><b>${esc(b.name)}</b><small>${esc(b.text)}</small></span>`).join('')}</div></section>` : ''}
    <section><h3>Mais jogados</h3>${p.games.length ? `<ol class="top">${p.games.slice(0, 6).map((g) => `<li>${cover(g.key)}<div><b>${esc(g.title)}</b><small>${hours(g.ms)} · ${g.sessions} ${g.sessions === 1 ? 'sessão' : 'sessões'} · ${ago(g.last)}</small>${bar(g.ms, g0)}</div></li>`).join('')}</ol>` : '<p class="f-empty">Nenhuma hora jogada ainda.</p>'}</section>
    ${p.common.length ? `<section><h3>Jogos em comum</h3><div class="vs">${p.common.map((c) => { const most = Math.max(c.mine, c.theirs); return `<div class="vs-row"><b>${esc(c.title)}</b><span>Você · ${hours(c.mine)}</span>${bar(c.mine, most)}<span>${esc(p.name.split(/\s+/)[0])} · ${hours(c.theirs)}</span>${bar(c.theirs, most)}</div>`; }).join('')}</div></section>` : ''}
    ${p.recent.length ? `<section><h3>Atividade recente</h3><ul class="recent">${p.recent.map((r) => `<li>${cover(r.key)}<span><b>${esc(r.title)}</b><small>${when(r)}</small></span></li>`).join('')}</ul></section>` : ''}
    ${p.with.length ? `<section><h3>Jogou junto recentemente</h3><div class="chips-p">${p.with.map((w) => `<button type="button" class="pchip" data-f-profile="${esc(w.id)}">${avatar(w.id, w.name)}${esc(w.name)}<small>${ago(w.at)}</small></button>`).join('')}</div></section>` : ''}
    ${p.mutual.length ? `<section><h3>Amigos em comum</h3><div class="chips-p">${p.mutual.map((m) => `<button type="button" class="pchip" data-f-profile="${esc(m.id)}">${avatar(m.id, m.name)}${esc(m.name)}</button>`).join('')}</div></section>` : ''}
  </div></div>`;
}

let returnFocus = null;
let openProfile = null;
async function showProfile(id) {
  if (!layer.firstChild) returnFocus = document.activeElement;
  openProfile = id;
  const r = await api(`profile/${encodeURIComponent(id)}`, { cache: 'no-store' }).catch(() => null);
  if (openProfile !== id) return;
  if (!r?.ok) return ask({ title: 'Perfil indisponível', text: 'Não deu para abrir esse perfil agora.', cancel: null });
  layer.innerHTML = profileHtml(await r.json());
  layer.querySelector('[data-f="close"]').focus();
}

function close() {
  openProfile = null;
  layer.innerHTML = '';
  returnFocus?.focus?.({ preventScroll: true });
}

// ---- inviting: which game ----
async function pickGame(id) {
  const f = state.social?.friends.find((x) => x.id === id);
  if (!f) return;
  // (the ready games, my last one first)
  const ready = (state.games ?? []).filter((g) => g.status.state === 'ready').sort((a, b) => (b.key === state.last) - (a.key === state.last));
  if (!layer.firstChild) returnFocus = document.activeElement;
  layer.innerHTML = `<div class="modal" data-f="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pi-title">
    <header><h2 id="pi-title">Chamar ${esc(f.name)} para jogar</h2><button class="btn quiet" data-f="close" aria-label="Fechar">${icon('close')}</button></header>
    <p>Se você estiver com uma sala aberta no jogo, o convite leva o código: aceitar já entra nela.</p>
    <div class="pick">${ready.map((g) => `<button type="button" data-f-send="${esc(id)}" data-key="${esc(g.key)}"><img src="${esc(g.cover)}" alt=""><b>${esc(g.name)}</b></button>`).join('') || '<p class="f-empty">Nenhum jogo pronto na biblioteca.</p>'}</div>
    <p class="error" id="pi-error" hidden></p></div></div>`;
  layer.querySelector('[data-f-send]')?.focus();
}

// ---- the Amigos screen (#amigos): the whole list; your status and note, adding by name, sent, activity ----
const page = $('amigos');
const atPage = () => location.hash === '#amigos';

let tab = 'all';
let sort = 'seen';
let feedAll = false;

/** The fields (search, status, note) are drawn once on entering, so typing isn't redrawn under the cursor; the rest follows every poll. */
function pageShell(s) {
  const opt = (v) => `<option value="${v}"${s.status === v ? ' selected' : ''}>${STATUS[v]}</option>`;
  return `<header class="fp-head">
      <div><h1 id="fp-title">Amigos</h1><p class="sub">Conecte-se, jogue junto e acompanhe a atividade da galera.</p></div>
      <label class="fp-search">${icon('search')}<span class="sr">Buscar amigos</span><input id="fp-q" type="search" placeholder="Buscar amigos…" autocomplete="off"><kbd>Ctrl K</kbd></label>
      <button type="button" class="btn" data-fp-add>${icon('users')}Adicionar amigo</button>
    </header>
    <div class="fp-main">
      <div class="fp-stats" id="fp-stats"></div>
      <section class="fp-box fp-friends" aria-label="Seus amigos">
        <div class="fp-bar"><div class="pills" id="fp-tabs" role="group" aria-label="Mostrar"></div>
          <label class="fp-sort"><span>Ordenar</span><select class="field" id="fp-sort"><option value="seen">Última atividade</option><option value="name">Nome</option></select></label></div>
        <div id="fp-invites"></div>
        <div class="fp-rows" id="fp-list"></div>
      </section>
      <section class="fp-box" id="fp-common" aria-labelledby="fp-common-title"></section>
    </div>
    <aside class="fp-side">
      <section class="fp-box fp-me" aria-label="Você">
        <div class="fp-me-head">${avBtn(s.id, state.me)}<div class="who"><b>${profileBtn(s.id, state.me)}</b><button type="button" class="link" data-f-me>Ver meu perfil</button></div>
          <label class="fp-status"><span class="sr">Seu status</span><select class="field" id="fm-status">${['online', 'away', 'busy', 'invisible'].map(opt).join('')}</select></label></div>
        <div class="fp-me-stats" id="fp-me-stats"></div>
        <label class="fm-label"><span>Recado (aparece embaixo do seu nome)</span><input class="field" id="fm-note" maxlength="80" placeholder="Procurando alguém pra jogar…" value="${esc(s.note)}"></label>
      </section>
      <section class="fp-box" id="fp-feed" aria-labelledby="fp-feed-title"></section>
      <section class="fp-box" id="fp-badges" aria-labelledby="fp-badges-title"></section>
      <section class="fp-box" id="fp-suggest" aria-labelledby="fp-suggest-title"></section>
      <p class="fp-hint">Dentro de um jogo, <b>Shift+Tab</b> abre seus amigos por cima da tela.</p>
    </aside>`;
}

const plain = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coverOf = (key, title) => { const g = gameOf(key); return g ? `<img src="${esc(g.cover)}" alt="${esc(g.name)}" title="${esc(g.name)}" loading="lazy">` : `<span class="nocover" title="${esc(title)}"></span>`; };
const BADGE_ICON = { first: 'trophy', veteran: 'crown', loyal: 'star', collector: 'joystick', marathon: 'bolt', crew: 'users' };

/** One row of the screen's list: who, what they're doing, their last games, and what you can do with them. */
function fpRow(f) {
  const p = around(f.id);
  const room = p?.room && gameOf(p.room.key) ? p.room : null;
  const title = p?.game?.title ?? (room && gameOf(room.key).name);
  const on = f.status !== 'offline';
  const doing = !on ? (f.seen ? `Visto ${ago(f.seen)}` : 'Offline') : p?.game?.watch ? `Assistindo ${title}` : title ? `Jogando ${title}` : STATUS[f.status];
  const cls = title && on ? 'ok live' : SHAPE[f.status];
  const games = f.games ?? [];
  const more = (f.more ?? 0);
  const join = room ? `${room.busy ? '' : `<button class="btn small" data-play="${esc(room.key)}" data-join="${esc(room.code)}">${icon('users')}Entrar</button>`}<button class="btn second small" data-play="${esc(room.key)}" data-join="${esc(room.code)}" data-watch>${icon('play')}Assistir</button>` : '';
  const canInvite = on && f.status !== 'busy';
  return `<div class="fp-row${on ? '' : ' off'}">
    <span class="fp-av s-${on ? f.status : 'offline'}">${avBtn(f.id, f.name)}</span>
    <div class="who"><b>${profileBtn(f.id, f.name)}${p?.call ? '<span class="tag">NA CALL</span>' : ''}</b><span class="state ${cls}">${esc(doing)}</span></div>
    <div class="fp-games">${games.map((g) => coverOf(g.key, g.title)).join('')}${more ? `<span class="fp-more">+${more}</span>` : ''}</div>
    <div class="acts">${join}
      <button type="button" class="round" data-f-invite="${esc(f.id)}"${canInvite ? '' : ' disabled'} aria-label="Convidar ${esc(f.name)} para jogar" title="${canInvite ? 'Convidar para jogar' : on ? 'Não perturbe' : 'Offline'}">${icon('chat')}</button>
      <button type="button" class="round" data-f-profile="${esc(f.id)}" aria-label="Ver o perfil de ${esc(f.name)}">${icon('more')}</button></div>
  </div>`;
}

function requestRow(r, sent) {
  return `<div class="fp-row"><span class="fp-av">${avBtn(r.id, r.name)}</span>
    <div class="who"><b>${profileBtn(r.id, r.name)}</b><span class="state${sent ? ' busy' : ''}">${sent ? 'Pedido enviado' : 'Pediu amizade'}</span></div><div class="fp-games"></div>
    <div class="acts">${sent ? `<button class="btn quiet small" data-f-remove="${esc(r.id)}">Cancelar</button>`
      : `<button class="btn small" data-f-add="${esc(r.id)}">Aceitar</button><button class="btn quiet small" data-f-remove="${esc(r.id)}" aria-label="Recusar o pedido de ${esc(r.name)}">${icon('close')}</button>`}</div></div>`;
}

function renderPage() {
  const s = state.social;
  if (!s || page.hidden) return;
  if (!$('fp-list')) { page.innerHTML = pageShell(s); $('fp-sort').value = sort; }
  const live = liveCount(s);
  const ms = s.friends.reduce((t, f) => t + (f.ms ?? 0), 0);
  const common = s.common ?? [];
  const stat = (tone, ic, n, label) => `<div class="fp-stat ${tone}"><span class="ic">${icon(ic)}</span><div><b class="num">${n}</b><span>${label}</span></div></div>`;
  set($('fp-stats'), stat('pink', 'users', s.friends.length, s.friends.length === 1 ? 'Amigo adicionado' : 'Amigos adicionados')
    + stat('green', 'joystick', `${live}${live ? '<i class="dot" aria-hidden="true"></i>' : ''}`, 'Online agora')
    + stat('violet', 'chart', esc(hours(ms)), 'Horas da galera')
    + stat('gold', 'trophy', common.length, common.length === 1 ? 'Jogo em comum' : 'Jogos em comum'));
  // the list: the tab, the search, the order
  const counts = { all: s.friends.length, online: live, offline: s.friends.length - live, requests: s.incoming.length + s.outgoing.length };
  const names = { all: 'Todos', online: 'Online', offline: 'Offline', requests: 'Solicitações' };
  set($('fp-tabs'), Object.keys(names).map((k) => `<button type="button" class="pill${k === tab ? ' on' : ''}" data-fp-tab="${k}" aria-pressed="${k === tab}">${names[k]} <span class="num">(${counts[k]})</span></button>`).join(''));
  const q = plain($('fp-q')?.value.trim() ?? '');
  const match = (x) => !q || plain(x.name).includes(q);
  let rows;
  if (tab === 'requests') rows = [...s.incoming.filter(match).map((r) => requestRow(r, false)), ...s.outgoing.filter(match).map((r) => requestRow(r, true))];
  else {
    const playingFirst = (f) => (f.status === 'offline' ? 2 : around(f.id)?.game || around(f.id)?.room ? 0 : 1);
    const list = s.friends.filter((f) => match(f) && (tab === 'all' || (tab === 'online') === (f.status !== 'offline')))
      .sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'pt-BR')
        : (a, b) => playingFirst(a) - playingFirst(b) || (b.seen ?? 0) - (a.seen ?? 0) || a.name.localeCompare(b.name, 'pt-BR'));
    rows = list.map(fpRow);
  }
  const empty = q ? 'Ninguém com esse nome na sua lista.' : tab === 'requests' ? 'Nenhum pedido de amizade agora.' : tab === 'online' ? 'Nenhum amigo online agora.'
    : !s.friends.length ? 'Adicione quem joga com você para ver o que estão jogando e chamar para uma partida.' : 'Ninguém aqui.';
  set($('fp-list'), rows.join('') || `<p class="f-empty">${empty}</p>`);
  set($('fp-invites'), s.invites.map(invite).join(''));
  // games in common (the ones in the library), the rest as "+N outros"
  const shown = common.filter((c) => gameOf(c.key));
  const tiles = shown.slice(0, 5).map((c) => { const g = gameOf(c.key); return `<button type="button" class="fp-game" data-open="${esc(c.key)}"><img src="${esc(g.cover)}" alt="" loading="lazy"><b>${esc(g.name)}</b><small>${c.friends} ${c.friends === 1 ? 'amigo jogou' : 'amigos jogaram'}</small></button>`; });
  const rest = common.length - tiles.length;
  $('fp-common').hidden = !common.length;
  set($('fp-common'), common.length ? `<div class="fp-title"><h2 id="fp-common-title">Jogos em comum</h2><span class="sub">${common.length} ${common.length === 1 ? 'jogo' : 'jogos'}</span></div>
    <div class="fp-games-grid">${tiles.join('')}${rest > 0 ? `<div class="fp-game rest"><b class="num">+${rest}</b><small>${rest === 1 ? 'outro' : 'outros'}</small></div>` : ''}</div>` : '');
  // you
  set($('fp-me-stats'), `<div>${icon('joystick')}<b class="num">${s.mine?.games ?? 0}</b><span>Jogos</span></div><div>${icon('users')}<b class="num">${s.friends.length}</b><span>Amigos</span></div><div>${icon('clock')}<b class="num">${esc(hours(s.mine?.ms ?? 0))}</b><span>Tempo jogado</span></div>`);
  // the friends' activity
  const feed = feedAll ? s.feed : s.feed.slice(0, 4);
  set($('fp-feed'), `<div class="fp-title"><h2 id="fp-feed-title">Atividade dos amigos</h2>${s.feed.length > 4 ? `<button type="button" class="link" data-fp-feed>${feedAll ? 'Ver menos' : 'Ver tudo'} ${icon('right')}</button>` : ''}</div>
    ${feed.length ? `<ul class="fp-feed">${feed.map((e) => { const g = gameOf(e.key); return `<li>${coverOf(e.key, e.title)}<span><b>${profileBtn(e.id, e.name)} jogou ${esc(e.title)}</b><small>${when(e)}</small></span>${g?.status.state === 'ready' ? `<button type="button" class="round" data-play="${esc(g.key)}" aria-label="Jogar ${esc(g.name)}">${icon('play')}</button>` : ''}</li>`; }).join('')}</ul>` : '<p class="f-empty">Quando seus amigos jogarem, aparece aqui.</p>'}`);
  // the friends' badges
  const badges = s.badges ?? [];
  $('fp-badges').hidden = !badges.length;
  set($('fp-badges'), badges.length ? `<div class="fp-title"><h2 id="fp-badges-title">Conquistas da galera</h2></div>
    <div class="fp-badges">${badges.map((b) => `<span class="fp-badge b-${esc(b.id)}" title="${esc(`${b.name}: ${b.text} — ${b.who.join(', ')}`)}">${icon(BADGE_ICON[b.id] ?? 'star')}<span class="sr">${esc(b.name)}: ${esc(b.who.join(', '))}</span></span>`).join('')}</div>
    <p class="fp-hint">${badges.length} ${badges.length === 1 ? 'conquista' : 'conquistas'} entre seus amigos</p>` : '');
  // people to add
  const suggest = s.suggest ?? [];
  $('fp-suggest').hidden = !suggest.length;
  set($('fp-suggest'), suggest.length ? `<div class="fp-title"><h2 id="fp-suggest-title">Sugestões de amizade</h2></div>
    ${suggest.map((u) => `<div class="fp-sug">${avBtn(u.id, u.name)}<div class="who"><b>${profileBtn(u.id, u.name)}</b><small>${esc([u.mutual && `${u.mutual} ${u.mutual === 1 ? 'amigo' : 'amigos'} em comum`, u.common && `${u.common} ${u.common === 1 ? 'jogo' : 'jogos'} em comum`, !u.mutual && u.together && 'Jogou com você'].filter(Boolean).join(' · '))}</small></div>
      <button type="button" class="round" data-f-add="${esc(u.id)}" aria-label="Adicionar ${esc(u.name)}">${icon('plus')}</button></div>`).join('')}` : '');
}

/** "Adicionar amigo": search by name, over the screen. */
function addDialog() {
  if (!layer.firstChild) returnFocus = document.activeElement;
  layer.innerHTML = `<div class="modal" data-f="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="fa-title">
    <header><h2 id="fa-title">Adicionar amigo</h2><button class="btn quiet" data-f="close" aria-label="Fechar">${icon('close')}</button></header>
    <input class="field" id="fm-q" type="search" placeholder="Nome de quem já abriu o HypePlay" autocomplete="off" aria-label="Buscar pelo nome">
    <div class="people-list" id="fm-results"></div></div></div>`;
  layer.querySelector('#fm-q').focus();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-fp-tab],[data-fp-feed],[data-fp-add]');
  if (!el) return;
  if (el.dataset.fpTab) tab = el.dataset.fpTab;
  if ('fpFeed' in el.dataset) feedAll = !feedAll;
  if ('fpAdd' in el.dataset) return addDialog();
  renderPage();
});
document.addEventListener('input', (e) => { if (e.target.id === 'fp-q') renderPage(); });
document.addEventListener('change', (e) => { if (e.target.id === 'fp-sort') { sort = e.target.value; renderPage(); } });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && $('fp-q') && !page.hidden) { e.preventDefault(); $('fp-q').focus(); }
});

/** In or out of the screen, by the address (store.js does the same for #loja; the bar's mark is the CSS's, body.in-friends). */
function route() {
  const on = atPage() && !!state.social;
  document.body.classList.toggle('in-friends', on);
  page.hidden = !on;
  if (!on) page.innerHTML = '';
  renderFriends();
}

let searching = 0;
async function search(q) {
  const n = ++searching;
  const r = q.trim() ? await api(`users?q=${encodeURIComponent(q)}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : [])).catch(() => []) : [];
  if (n !== searching || !$('fm-results')) return;
  const label = { friend: '<span class="state ok">Na sua lista</span>', outgoing: '<span class="state busy">Pedido enviado</span>', incoming: '<span class="state warn">Pediu amizade</span>' };
  $('fm-results').innerHTML = r.map((u) => `<div class="person">${avBtn(u.id, u.name)}<div class="who"><b>${profileBtn(u.id, u.name)}</b>${label[u.relation] ?? ''}</div>
    ${u.relation === 'none' || u.relation === 'incoming' ? `<div class="acts"><button class="btn small" data-f-add="${esc(u.id)}">${u.relation === 'incoming' ? 'Aceitar' : 'Adicionar'}</button></div>` : ''}</div>`).join('')
    || (q.trim() ? '<p class="f-empty">Ninguém com esse nome. A pessoa precisa ter aberto o HypePlay uma vez.</p>' : '');
}

async function refresh() {
  await poll();
  if (openProfile) showProfile(openProfile);
  if ($('fm-q')?.value) search($('fm-q').value);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-f],[data-f-profile],[data-f-add],[data-f-remove],[data-f-unfriend],[data-f-invite],[data-f-send],[data-f-answer],[data-f-manage],[data-f-offline],[data-f-me],[data-me]');
  if (!el) return;
  const d = el.dataset;
  if (d.f === 'close' || (d.f === 'scrim' && e.target === el)) return close();
  if (d.f) return;
  if (d.fProfile) return showProfile(d.fProfile);
  if ('fMe' in d || 'me' in d) return state.social && showProfile(state.social.id);
  if ('fManage' in d) { location.hash = 'amigos'; return; }
  if ('fOffline' in d) { showOffline = !showOffline; return renderFriends(); }
  if (d.fInvite) return pickGame(d.fInvite);
  if (d.fAnswer) {
    // (an accepted invite's button also opens the game: app.js' data-play, at once; keepalive gets this there anyway)
    send(`invite/${encodeURIComponent(d.fAnswer)}`, 'POST', { accept: 'fAccept' in d });
    state.social.invites = state.social.invites.filter((i) => i.id !== d.fAnswer);
    return renderFriends();
  }
  el.disabled = true;
  if (d.fSend) {
    const r = await send('invite', 'POST', { to: d.fSend, key: d.key }).catch(() => null);
    if (r?.ok) { close(); toast(`${icon('check')}<p>Convite enviado</p>`); }
    else { const err = $('pi-error'); err.hidden = false; err.textContent = (await r?.json().catch(() => null))?.error ?? 'Não deu para enviar o convite.'; el.disabled = false; }
    return;
  }
  if (d.fAdd) {
    const r = await send(`friends/${encodeURIComponent(d.fAdd)}`, 'POST').then((x) => x.json()).catch(() => null);
    if (r?.result === 'sent') toast(`${icon('check')}<p>Pedido enviado</p>`);
    else if (r?.error) toast(`${icon('close')}<p>${esc(r.error)}</p>`);
  }
  if (d.fRemove) await send(`friends/${encodeURIComponent(d.fRemove)}`, 'DELETE');
  if (d.fUnfriend) {
    const name = state.social?.friends.find((f) => f.id === d.fUnfriend)?.name ?? 'essa pessoa';
    if (await ask({ title: `Desfazer amizade com ${name}?`, text: 'Vocês saem da lista um do outro. As horas jogadas continuam no perfil.', ok: 'Desfazer', danger: true }))
      await send(`friends/${encodeURIComponent(d.fUnfriend)}`, 'DELETE');
    else return showProfile(d.fUnfriend);
  }
  await refresh();
});

let typing = 0;
document.addEventListener('input', (e) => {
  if (e.target.id === 'fm-q') search(e.target.value);
  if (e.target.id === 'fm-note') { clearTimeout(typing); typing = setTimeout(() => send('status', 'PUT', { note: e.target.value }).then(poll), 600); }
});
document.addEventListener('change', (e) => { if (e.target.id === 'fm-status') send('status', 'PUT', { status: e.target.value }).then(poll); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layer.querySelector('[data-f="scrim"]')) { e.stopPropagation(); close(); }
}, true);

// The bar's "Pessoas" becomes "Amigos" and opens its screen; the name in the corner opens your own profile.
const nav = document.querySelector('[data-nav="people"]');
nav.title = 'Amigos';
nav.querySelector('.t').textContent = 'Amigos';
// (before store.js' and app.js' own: no scrolling to the side column. Without friends, "Pessoas" scrolls as before)
nav.addEventListener('click', (e) => { if (!state.social) return; e.stopImmediatePropagation(); location.hash = 'amigos'; }, true);
for (const b of document.querySelectorAll('[data-nav]:not([data-nav="people"])'))
  b.addEventListener('click', () => { if (atPage()) { history.pushState(null, '', location.pathname + location.search); route(); } });
addEventListener('hashchange', route);
hooks.peopleFallback = hooks.people;
hooks.people = () => { if (atPage() && page.hidden && state.social) route(); else renderFriends(); };
route();
