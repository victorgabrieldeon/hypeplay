// pad.js (bundled at startup, server/index.ts; slipped into every game's page by the server): the person's controller
// maps, made on the home's Controle screen, in front of navigator.getGamepads(), so a PS2 pad the browser doesn't know
// reaches the game as the standard layout it reads. Without maps (or if they don't load) the game sees the real pads.
// It also lists the online guest's pad (guestpad.ts) while one is connected, for the host's game (stream.ts), and, on
// the PS2 games' pages, the person's own keys (keymap.ts) as player 1.
import { GuestPads } from "./guestpad";
import { keyCodes, keyPad, validKeyMap, withKeys, type KeyMap } from "./keymap";
import { install, type Mapping, type PadLike } from "./padmap";

const maps: Record<string, Mapping> = {};
const guests = new GuestPads();
/** Only the emulator's and the fast version's pages: BT3 and the guest's page keep their own keyboard. */
const PS2_PAGE = /\/ps2\/[^/]+\/(game|fast)\//;
let keys: KeyMap | null = null;
/** The keyboard shows up as a pad once a mapped key is first pressed, like a controller's first press. */
let plugged = false;
const held = new Set<string>();
let keyAt = 0;

if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
  const nav = navigator as unknown as { getGamepads(): (PadLike | null)[] };
  install(nav, maps);
  const real = nav.getGamepads.bind(nav);
  // (Discord can refuse the gamepads in its window: the keyboard still plays)
  const mapped = () => {
    try {
      return [...real()];
    } catch {
      return [];
    }
  };
  const local = () => withKeys(mapped(), keys && plugged ? keyPad(keys, held, keyAt) : null);
  nav.getGamepads = () => guests.list(local());
  // pad.js lives at /p/<pass>/pad.js; the maps are next to it, at /p/<pass>/pad, and the keys at /p/<pass>/keys.
  const here = (document.currentScript as HTMLScriptElement | null)?.src;
  if (here)
    fetch(new URL("pad", here), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, Mapping>) => Object.assign(maps, m))
      .catch(() => {});
  if (here && PS2_PAGE.test(location.pathname))
    fetch(new URL("keys", here), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: unknown) => {
        if (validKeyMap(m)) listen(m);
      })
      .catch(() => {});

  /** Mapped keys go to the keyboard pad only (before the game's own listeners: pad.js runs first). */
  function listen(m: KeyMap) {
    keys = m;
    const codes = keyCodes(m);
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
    window.addEventListener(
      "keydown",
      (e) => {
        if (!codes.has(e.code) || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (held.has(e.code)) return;
        held.add(e.code);
        keyAt = performance.now();
        if (plugged) return;
        const before = nav.getGamepads();
        plugged = true;
        announce(before);
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (e) => {
        if (!held.delete(e.code)) return;
        keyAt = performance.now();
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    window.addEventListener("blur", () => {
      held.clear();
      keyAt = performance.now();
    });
  }

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
      const before = local();
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
