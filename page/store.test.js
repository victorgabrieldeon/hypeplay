import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

async function store(fetch) {
  const events = {};
  const timers = new Map();
  const fields = { 'l-q': { value: 'naruto', focus() {} }, 'l-job': { innerHTML: '' } };
  const buttons = [{ disabled: false }];
  const layer = {
    get innerHTML() { return this.html || ''; },
    set innerHTML(html) { this.html = html; buttons[0].disabled = /data-l="get" disabled/.test(html); },
    addEventListener: (event, fn) => events[event] = fn, querySelectorAll: () => buttons,
  };
  const hooks = {};
  let clock = 0;
  const source = await Bun.file(new URL('./home/store.js', import.meta.url)).text();
  runInNewContext(source.replace(/^import .*;$/gm, ''), {
    document: { getElementById: (id) => id === 'layer' ? layer : fields[id], activeElement: null, addEventListener() {} },
    hooks, state: { me: 'Ana' }, gameOf: () => null, poll() {}, esc: String, icon: () => '', gb: String, pct: () => 0, fetch,
    setTimeout: (fn) => { timers.set(++clock, fn); return clock; }, clearTimeout: (id) => timers.delete(id),
  });
  return {
    hooks, layer, fields, buttons, timers,
    search: () => events.submit({ target: { matches: () => true }, preventDefault() {} }),
    close: () => events.click({ target: { closest: () => ({ dataset: { l: 'close' } }) } }),
    install: () => events.click({ target: { closest: () => ({ dataset: { l: 'install', id: '8849' } }) } }),
  };
}

test('store status polling retries a transient failure and releases installation controls', async () => {
  let statuses = 0;
  const ui = await store(async (_, init) => {
    if (init?.method === 'POST') return Response.json({ state: 'resolving', by: 'Ana' });
    if (++statuses === 2) throw new Error('offline');
    return Response.json(statuses === 1 ? { state: 'idle' } : { state: 'done', by: 'Ana', name: 'Naruto' });
  });
  ui.hooks.store();
  await Bun.sleep(0);
  await ui.install();
  await Bun.sleep(0);
  expect(ui.buttons[0].disabled).toBe(true);
  expect(ui.timers.size).toBe(1);
  const retry = [...ui.timers.values()][0];
  await retry();
  expect(ui.buttons[0].disabled).toBe(false);
  expect(ui.fields['l-job'].innerHTML).toContain('entrou');
  ui.close();
});

test('a closed store cannot overwrite a reopened search for the same term', async () => {
  const pending = [];
  const ui = await store((url) => url === 'vimm' ? Promise.resolve(Response.json({ state: 'idle' })) : new Promise((resolve) => pending.push(resolve)));
  ui.hooks.store();
  const old = ui.search();
  ui.close();
  ui.hooks.store();
  const current = ui.search();
  pending[1](Response.json({ games: [{ id: 8849, name: 'New results', regions: ['USA'], automatic: true }] }));
  await current;
  pending[0](Response.json({ games: [{ id: 8849, name: 'Old results', regions: ['USA'], automatic: false }] }));
  await old;
  expect(ui.layer.innerHTML).toContain('New results');
  expect(ui.layer.innerHTML).not.toContain('Old results');
  ui.close();
});
