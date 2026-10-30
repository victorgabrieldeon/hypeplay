// The controller screen's drawings (original, no logos): the PS2's own pad, the PS4/PS5 family's and an Xbox pad, each
// with the same ids on its controls (k-cross, k-l1, ...) so mapping and testing light the same button on any of them.
// The map is always the PS2's: these only show where that button sits on the pad in hand, and what it's called there.

export const FAMILIES = [['ps2', 'PS2'], ['ps5', 'PS5'], ['xbox', 'Xbox']];

const DIRS = { up: 'direcional para cima', down: 'direcional para baixo', left: 'direcional para a esquerda', right: 'direcional para a direita' };
const PS2 = { cross: '✕', circle: '○', square: '□', triangle: '△', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'Select', start: 'Start', l3: 'L3', r3: 'R3', ...DIRS };
/** Each button's name on each pad. */
export const NAMES = {
  ps2: PS2,
  ps5: { ...PS2, select: 'Create', start: 'Options' },
  xbox: { cross: 'A', circle: 'B', square: 'X', triangle: 'Y', l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', select: 'View', start: 'Menu', l3: 'LS', r3: 'RS', ...DIRS },
};

const sticks = (lx, ly, rx, ry) => `<circle id="k-l3" class="k" cx="${lx}" cy="${ly}" r="30"/><circle id="k-r3" class="k" cx="${rx}" cy="${ry}" r="30"/>
  <circle id="k-lx" class="k" cx="${lx}" cy="${ly}" r="12" style="opacity:0"/><circle id="k-ry" class="k" cx="${rx}" cy="${ry}" r="12" style="opacity:0"/>
  <circle id="dot-l" cx="${lx}" cy="${ly}" r="10" fill="#a08cff"/><circle id="dot-r" cx="${rx}" cy="${ry}" r="10" fill="#a08cff"/>`;

const dpad = (x, y, arm = 26, width = 24) => {
  const h = width / 2;
  return `<rect id="k-up" class="k" x="${x - h}" y="${y - h - arm}" width="${width}" height="${arm}" rx="5"/>
  <rect id="k-down" class="k" x="${x - h}" y="${y + h}" width="${width}" height="${arm}" rx="5"/>
  <rect id="k-left" class="k" x="${x - h - arm}" y="${y - h}" width="${arm}" height="${width}" rx="5"/>
  <rect id="k-right" class="k" x="${x + h}" y="${y - h}" width="${arm}" height="${width}" rx="5"/>`;
};

const AROUND = [['triangle', 0, -1], ['square', -1, 0], ['circle', 1, 0], ['cross', 0, 1]];
/** Four face buttons around (x, y), `gap` from the middle; `mark(button, cx, cy)` draws what's printed on each. */
const face = (x, y, gap, mark, r = 17) =>
  AROUND.map(([k, dx, dy]) => `<circle id="k-${k}" class="k" cx="${x + dx * gap}" cy="${y + dy * gap}" r="${r}"/>`).join('') +
  AROUND.map(([k, dx, dy]) => mark(k, x + dx * gap, y + dy * gap)).join('');

/** The PlayStation marks, drawn (a font's □ comes out smaller than its ○). */
const psMark = (k, x, y) => ({
  triangle: `<path class="mark" d="M${x} ${y - 7}l7.5 12.5h-15z"/>`,
  square: `<rect class="mark" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="1.5"/>`,
  circle: `<circle class="mark" cx="${x}" cy="${y}" r="6.5"/>`,
  cross: `<path class="mark" d="M${x - 6} ${y - 6}l12 12M${x + 6} ${y - 6}l-12 12"/>`,
})[k];
const XBOX = { triangle: ['Y', 'c-y'], square: ['X', 'c-x'], circle: ['B', 'c-b'], cross: ['A', 'c-a'] };
const xboxMark = (k, x, y) => `<text class="${XBOX[k][1]}" x="${x}" y="${y + 5}">${XBOX[k][0]}</text>`;

const shoulders = (l2, r2, l1, r1, round = 13) => `<rect id="k-l2" class="k" x="76" y="6" width="96" height="28" rx="${round}"/><rect id="k-r2" class="k" x="348" y="6" width="96" height="28" rx="${round}"/>
  <rect id="k-l1" class="k" x="78" y="38" width="94" height="20" rx="9"/><rect id="k-r1" class="k" x="348" y="38" width="94" height="20" rx="9"/>
  <text class="sm" x="124" y="24">${l2}</text><text class="sm" x="396" y="24">${r2}</text><text class="sm" x="125" y="52">${l1}</text><text class="sm" x="395" y="52">${r1}</text>`;


export const DRAWINGS = {
  ps2: `<svg class="padart" viewBox="0 0 520 300" aria-hidden="true">
  ${shoulders('L2', 'R2', 'L1', 'R1', 10)}
  <path class="body" d="M120 66h280c60 0 100 40 108 110l10 70c4 34-34 52-62 30l-58-48H122l-58 48c-28 22-66 4-62-30l10-70C20 106 60 66 120 66z"/>
  ${dpad(118, 140, 28, 28)}
  ${face(400, 140, 36, psMark, 18)}
  <rect id="k-select" class="k" x="210" y="128" width="34" height="14" rx="7"/><rect id="k-start" class="k" x="276" y="128" width="34" height="14" rx="7"/>
  <text class="sm out" x="227" y="162">SELECT</text><text class="sm out" x="293" y="162">START</text>
  ${sticks(190, 214, 330, 214)}
</svg>`,

  ps5: `<svg class="padart" viewBox="0 0 520 300" aria-hidden="true">
  ${shoulders('L2', 'R2', 'L1', 'R1')}
  <path class="body" d="M148 62H372C424 62 454 86 470 130L502 236C512 272 478 296 448 276L396 238C386 231 374 228 360 228H160C146 228 134 231 124 238L72 276C42 296 8 272 18 236L50 130C66 86 96 62 148 62Z"/>
  <rect class="plate" x="200" y="70" width="120" height="74" rx="14"/>
  <rect id="k-select" class="k" x="171" y="76" width="14" height="26" rx="7"/><rect id="k-start" class="k" x="335" y="76" width="14" height="26" rx="7"/>
  <text class="sm out" x="176" y="120">CREATE</text><text class="sm out" x="345" y="120">OPTIONS</text>
  ${dpad(116, 136)}
  ${face(402, 136, 28, psMark, 16)}
  ${sticks(204, 194, 316, 194)}
</svg>`,

  xbox: `<svg class="padart" viewBox="0 0 520 300" aria-hidden="true">
  ${shoulders('LT', 'RT', 'LB', 'RB')}
  <path class="body" d="M150 62H370C426 62 456 92 472 140L496 224C508 266 472 292 440 270L394 238C382 230 368 228 354 228H166C152 228 138 230 126 238L80 270C48 292 12 266 24 224L48 140C64 92 94 62 150 62Z"/>
  <circle class="plate" cx="260" cy="90" r="15"/>
  <circle id="k-select" class="k" cx="228" cy="124" r="10"/><circle id="k-start" class="k" cx="292" cy="124" r="10"/>
  <text class="sm out" x="228" y="152">VIEW</text><text class="sm out" x="292" y="152">MENU</text>
  ${dpad(198, 186, 22, 20)}
  ${face(392, 124, 27, xboxMark, 16)}
  ${sticks(130, 124, 322, 188)}
</svg>`,
};
