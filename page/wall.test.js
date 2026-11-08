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
  // nothing to spotlight yet (an empty library)
  expect(arrange([], undefined, null)).toEqual([]);
});
