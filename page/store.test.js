import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

async function store(fetch) {
  const events = {};
  const timers = new Map();
  const fields = { 'store-q': { value: 'naruto', focus() {} }, 'store-job': { innerHTML: '' } };
  const buttons = [{ disabled: false }];
  const layer = {
    get innerHTML() { return this.html || ''; },
    set innerHTML(html) { this.html = html; buttons[0].disabled = /data-store-install="8849" disabled/.test(html); },
    addEventListener: (event, fn) => events[event] = fn, querySelectorAll: () => buttons,
  };
  const nav = { classList: { toggle() {} }, addEventListener() {} };
  const location = { hash: '#loja', pathname: '/', search: '' };
  let clock = 0;
  const source = await Bun.file(new URL('./home/store.js', import.meta.url)).text();
  runInNewContext(source.replace(/^import .*;$/gm, ''), {
    document: { getElementById: (id) => id === 'store' ? layer : fields[id], querySelector: () => nav, querySelectorAll: () => [], body: { classList: { toggle() {} } } },
    location, addEventListener: (event, fn) => events[event] = fn, scrollTo() {},
    state: { me: 'Ana' }, gameOf: () => null, poll() {}, esc: String, icon: () => '', gb: String, pct: () => 0,
    fetch: (url, init) => url === 'vimm/store' ? Promise.resolve(Response.json({ top: [{ id: 8849, name: 'Naruto', regions: ['USA'], automatic: true }], rated: [] })) : fetch(url, init),
    setTimeout: (fn) => { timers.set(++clock, fn); return clock; }, clearTimeout: (id) => timers.delete(id),
  });
  await Bun.sleep(0);
  return {
    layer, fields, buttons, timers,
    search: () => events.submit({ target: { matches: () => true }, preventDefault() {} }),
    navigate: (hash) => { location.hash = hash; events.hashchange(); },
    install: () => events.click({ target: { closest: () => ({ dataset: { storeInstall: '8849' } }) } }),
  };
}

test('store status polling retries a transient failure and releases installation controls', async () => {
  let statuses = 0;
  const ui = await store(async (_, init) => {
    if (init?.method === 'POST') return Response.json({ state: 'resolving', by: 'Ana' });
    if (++statuses === 2) throw new Error('offline');
    return Response.json(statuses === 1 ? { state: 'idle' } : { state: 'done', by: 'Ana', name: 'Naruto' });
  });
  ui.navigate('#loja/8849');
  await ui.install();
  await Bun.sleep(0);
  expect(ui.buttons[0].disabled).toBe(true);
  expect(ui.timers.size).toBe(1);
  const retry = [...ui.timers.values()][0];
  await retry();
  expect(ui.buttons[0].disabled).toBe(false);
  expect(ui.fields['store-job'].innerHTML).toContain('entrou');
});

test('an old store search cannot overwrite a newer search for the same term after navigation', async () => {
  const pending = [];
  const ui = await store((url) => url === 'vimm' ? Promise.resolve(Response.json({ state: 'idle' })) : new Promise((resolve) => pending.push(resolve)));
  const old = ui.search();
  ui.navigate('#library');
  ui.navigate('#loja');
  const current = ui.search();
  pending[1](Response.json({ games: [{ id: 8849, name: 'New results', regions: ['USA'], automatic: true }] }));
  await current;
  pending[0](Response.json({ games: [{ id: 8849, name: 'Old results', regions: ['USA'], automatic: false }] }));
  await old;
  expect(ui.layer.innerHTML).toContain('New results');
  expect(ui.layer.innerHTML).not.toContain('Old results');
});
