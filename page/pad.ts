// pad.js (bundled at startup, server/index.ts; slipped into every game's page by the server): the person's controller
// maps, made on the home's Controle screen, in front of navigator.getGamepads(), so a PS2 pad the browser doesn't know
// reaches the game as the standard layout it reads. Without maps (or if they don't load) the game sees the real pads.
import { install, type Mapping, type PadLike } from "./padmap";

const maps: Record<string, Mapping> = {};
if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
  install(navigator as unknown as { getGamepads(): (PadLike | null)[] }, maps);
  // pad.js lives at /p/<pass>/pad.js; the maps are next to it, at /p/<pass>/pad.
  const here = (document.currentScript as HTMLScriptElement | null)?.src;
  if (here)
    fetch(new URL("pad", here), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, Mapping>) => Object.assign(maps, m))
      .catch(() => {});
}
