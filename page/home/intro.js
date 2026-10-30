// Opening a game: it becomes the person's last one (the spotlight), the PS2 intro plays (intro.mp4 from the data
// volume, with sound: the click is the gesture), and a click, a key, its end or its absence goes on to the game.
// Only BT3 and the PS2 library get it; the homebrew shelf opens its emulator straight away.
import { gameUrl, hooks } from './app.js';

const layer = document.getElementById('layer');

hooks.play = (g, join, online) => {
  fetch('played', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: g.key }) }).catch(() => {});
  let gone = false;
  const leave = () => {
    if (gone) return;
    gone = true;
    removeEventListener('keydown', onKey, true);
    location.href = gameUrl(g, join, online);
  };
  const onKey = (e) => { e.preventDefault(); leave(); };
  layer.innerHTML = `<div class="intro" role="dialog" aria-label="Abrindo ${g.name.replace(/[<>&"]/g, '')}">
    <video src="intro.mp4" autoplay playsinline preload="auto"></video><small>Clique ou aperte uma tecla para pular</small></div>`;
  const video = layer.querySelector('video');
  video.addEventListener('ended', leave);
  video.addEventListener('error', leave);
  layer.querySelector('.intro').addEventListener('click', leave);
  addEventListener('keydown', onKey, true);
  // (a browser that still won't play sound plays it muted rather than not at all)
  video.play()?.catch(() => { video.muted = true; video.play()?.catch(leave); });
};
