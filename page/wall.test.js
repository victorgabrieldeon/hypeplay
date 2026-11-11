import { expect, test } from 'bun:test';
import { arrange } from './home/library.js';

const game = (name, state, open = 0, more = {}) => ({ key: name, name, status: { state, ...more }, open: Array.from({ length: open }, () => ({ code: 'X', busy: false })) });

test('the wall: the spotlight and games with a room big (3 at most), then what needs someone, what is on its way, the ready ones by name', () => {
  const top = game('Top', 'ready');
  const games = [
    game('Zeta', 'ready'), game('Alfa', 'ready'), game('Sala 1', 'ready', 1), game('Sala 2', 'ready', 2), game('Sala 3', 'ready', 1),
    game('Subindo', 'uploading', 0, { received: 1, size: 2 }), game('BIOS', 'needs-bios'), game('Quebrou', 'failed', 0, { message: '' }), top,
  ];
  const wall = arrange(games, top, null);
  expect(wall.map(({ g, big }) => `${g.name}${big ? '*' : ''}`)).toEqual(
    ['Top*', 'Sala 1*', 'Sala 2*', 'BIOS', 'Quebrou', 'Subindo', 'Alfa', 'Sala 3', 'Zeta']);
  // a short window: only the spotlight is big
  expect(arrange(games, top, null, 1).filter((c) => c.big).map((c) => c.g.name)).toEqual(['Top']);
  // the person's favorites come right after the big ones
  expect(arrange(games, top, null, 3, new Set(['Zeta', 'Sala 3'])).map(({ g }) => g.name).slice(3, 6)).toEqual(['Sala 3', 'Zeta', 'BIOS']);
  // nothing to spotlight yet (an empty library)
  expect(arrange([], undefined, null)).toEqual([]);
});

test('a favorite: a star on its cover, and the hero and drawer buttons say so', async () => {
  const { card, hero } = await import('./home/library.js');
  const { drawer } = await import('./home/drawer.js');
  const g = { ...game('Jogo', 'ready'), key: 'ps2/jogo', cover: 'c.png', kind: 'recomp', platform: 'PS2', steps: [] };
  expect(card(g, null, null, 0, false, true)).toContain('fav-mark');
  expect(card(g, null, null, 0, false, true)).toContain('Jogo (favorito)');
  expect(card(g, null, null, 0, false, false)).not.toContain('fav-mark');
  expect(hero(g, null, 'Em destaque', true)).toContain('data-fav="ps2/jogo" aria-pressed="true"');
  expect(hero(g, null, 'Em destaque', false)).toContain('aria-pressed="false"');
  expect(drawer(g, { sending: null, watching: new Map(), uploadError: { key: null } }, true)).toContain('data-fav="ps2/jogo" aria-pressed="true"');
});
