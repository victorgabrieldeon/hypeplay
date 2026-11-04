// A yes/no question in the page's own dialog. The home runs sandboxed inside Discord's Activity, where the browser's
// confirm() and alert() never show and confirm() answers false at once: a button behind one did nothing there.
// ask() resolves true on the confirming button, false on cancel, Escape or a click outside. Without `cancel` it's a
// notice: one button, resolves true.
import { esc, icon } from './library.js';

let layer = null;
let pending = null;

function finish(answer) {
  if (!pending) return;
  const { resolve, before } = pending;
  pending = null;
  layer.innerHTML = '';
  before?.focus?.();
  resolve(answer);
}

/** @param {{ title: string, text: string, ok?: string, cancel?: string | null, danger?: boolean }} o */
export function ask({ title, text, ok = 'OK', cancel = 'Cancelar', danger = false }) {
  if (!layer) {
    layer = document.body.appendChild(document.createElement('div'));
    layer.addEventListener('click', (e) => {
      const a = e.target.closest('[data-ask]')?.dataset.ask;
      if (a === 'ok') finish(true);
      else if (a === 'cancel' || (a === 'scrim' && e.target.dataset.ask === 'scrim')) finish(false);
    });
    document.addEventListener('keydown', (e) => {
      if (pending && e.key === 'Escape') { e.stopPropagation(); finish(false); }
    }, true);
  }
  finish(false); // (a question already open is answered "no")
  return new Promise((resolve) => {
    pending = { resolve, before: document.activeElement };
    layer.innerHTML = `<div class="modal" data-ask="scrim"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-text">
      <header><h2 id="ask-title">${esc(title)}</h2>${cancel === null ? '' : `<button class="btn quiet" data-ask="cancel" aria-label="Fechar">${icon('close')}</button>`}</header>
      <p id="ask-text">${esc(text)}</p>
      <footer>${cancel === null ? '' : `<button class="btn second" data-ask="cancel">${esc(cancel)}</button>`}<button class="btn${danger ? ' danger' : ''}" data-ask="ok">${esc(ok)}</button></footer>
    </div></div>`;
    // (the safe answer has the focus: Enter on a slip doesn't remove anything)
    layer.querySelector(cancel === null ? '[data-ask="ok"]' : 'footer [data-ask="cancel"]').focus();
  });
}
