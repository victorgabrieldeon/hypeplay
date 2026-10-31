// fastplay.js (bundled at startup, server/index.ts; put in the "versão rápida"'s page by routes.ts): its online, the
// emulator page's (ps2play.ts) in the game's panel (overlay.js). stream.ts opens the room (../room, the same rooms as
// the emulator's) and sends the page's canvas and sound; the guest's pad reaches the game through pad.js as one more
// gamepad, which the page reads as player 2. Opened from the library's "Abrir uma sala" (?online=host), it opens one.
import type { OverlayApi } from "./overlay";
import { roomButton } from "./stream";

async function main() {
  if (document.readyState === "loading") await new Promise((ok) => document.addEventListener("DOMContentLoaded", ok, { once: true }));
  const room = roomButton();
  (window as unknown as { hypeplayOverlay?: OverlayApi }).hypeplayOverlay?.online(
    "Abra uma sala: um amigo entra pela <b>biblioteca</b>, em <b>Entrar como jogador 2</b>, e joga com o controle dele.",
    room,
  );
  if (new URLSearchParams(location.search).get("online") === "host") room.click();
}

void main();
