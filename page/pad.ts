// pad.js (bundled at startup, server/index.ts; slipped into every game's page by the server): the person's controller
// maps, made on the home's Controle screen, in front of navigator.getGamepads(), so a PS2 pad the browser doesn't know
// reaches the game as the standard layout it reads. Without maps (or if they don't load) the game sees the real pads.
// It also lists the online guest's pad (guestpad.ts) while one is connected, for the host's game (stream.ts).
import { GuestPads } from "./guestpad";
import { install, type Mapping, type PadLike } from "./padmap";

const maps: Record<string, Mapping> = {};
const guests = new GuestPads();

if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
  const nav = navigator as unknown as { getGamepads(): (PadLike | null)[] };
  install(nav, maps);
  const mapped = nav.getGamepads.bind(nav);
  nav.getGamepads = () => guests.list([...mapped()]);
  // pad.js lives at /p/<pass>/pad.js; the maps are next to it, at /p/<pass>/pad.
  const here = (document.currentScript as HTMLScriptElement | null)?.src;
  if (here)
    fetch(new URL("pad", here), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, Mapping>) => Object.assign(maps, m))
      .catch(() => {});

  /** Games learn of new pads by this event: the stand-in (if any) first, then the guest. */
  const announce = (before: (PadLike | null)[]) => {
    const now = nav.getGamepads();
    for (const p of now) {
      if (!p || before.some((b) => b?.index === p.index && b.id === p.id)) continue;
      const e = new Event("gamepadconnected") as Event & { gamepad?: unknown };
      e.gamepad = p;
      window.dispatchEvent(e);
    }
  };
  (window as unknown as { cordplayGuest: unknown }).cordplayGuest = {
    join() {
      const before = mapped();
      guests.join();
      announce(before);
    },
    set: (msg: unknown) => guests.set(msg),
    leave() {
      const before = nav.getGamepads();
      guests.leave();
      for (const p of before) {
        if (!p || nav.getGamepads().some((n) => n?.id === p.id)) continue;
        const e = new Event("gamepaddisconnected") as Event & { gamepad?: unknown };
        e.gamepad = { ...p, connected: false };
        window.dispatchEvent(e);
      }
    },
  };
}
