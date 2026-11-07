/**
 * The PS2 memory card between this browser and the server (ps2play.ts runs it; no DOM here, so it's tested alone).
 * The server's copy is the person's save, so it must never be lost or overwritten by mistake:
 *
 *   - a save is kept here first ("dirty", in the emulator's own IndexedDB) and only then sent; it's retried until it
 *     goes through, and the page asks before closing while one is on its way;
 *   - a card left unsent (the page closed mid-upload) goes up first next time, instead of being overwritten;
 *   - only the server saying there is no save (404) makes a blank card; when the save can't be fetched, nothing is
 *     seeded and nothing is sent this session, so a blank card can never be saved over the real one.
 */

export const CARD_BYTES = 8_650_752;
const LOCK = "tabstationtoo-memcards";
const GET_TRIES = 3;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/** Where a card not yet on the server waits (ps2play.ts: IndexedDB). */
export interface CardStore {
  getDirty(): Promise<Uint8Array | null>;
  setDirty(bytes: Uint8Array | null): Promise<void>;
}

export interface CardSyncDeps {
  fetch: typeof fetch;
  store: CardStore;
  /** On while a save is on its way: the page asks before it closes. */
  guard(on: boolean): void;
  wait?: (ms: number) => Promise<void>;
  url?: string;
}

export function createCardSync({ fetch, store, guard, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), url = "../save" }: CardSyncDeps) {
  let saving = true;
  let latest: Uint8Array | null = null;
  let running: Promise<void> | null = null;

  async function put(bytes: Uint8Array) {
    try {
      const r = await fetch(url, { method: "PUT", body: bytes as Uint8Array<ArrayBuffer> });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function run() {
    guard(true);
    do {
      while (latest) {
        const bytes = latest;
        latest = null;
        for (let tries = 0; !(await put(bytes)); tries++) {
          await wait(BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!);
          if (latest) break; // a newer save replaces this one
        }
      }
      await store.setDirty(null).catch(() => {});
    } while (latest); // (a save that came while the last one was being cleared: saved() found this run still going)
    guard(false);
    running = null;
  }

  return {
    /** The card to put in slot 1, and whether this session's saves reach the server. */
    async start(): Promise<{ seed: Uint8Array | null; saving: boolean }> {
      const dirty = await store.getDirty().catch(() => null);
      if (dirty) {
        for (let tries = 0; tries < GET_TRIES; tries++) {
          if (await put(dirty)) {
            await store.setDirty(null).catch(() => {});
            break;
          }
          await wait(BACKOFF_MS[tries]!);
        }
        return { seed: dirty, saving: true };
      }
      for (let tries = 0; tries < GET_TRIES; tries++) {
        const r = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (r?.status === 404) return { seed: new Uint8Array(CARD_BYTES).fill(0xff), saving: true };
        if (r?.ok) {
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length === CARD_BYTES) return { seed: bytes, saving: true };
        }
        await wait(1_000 * (tries + 1));
      }
      saving = false;
      return { seed: null, saving: false };
    },

    /** The game saved: keep it here, then send it (the latest one wins; one upload at a time). */
    saved(bytes: Uint8Array): Promise<void> {
      if (!saving) return Promise.resolve();
      const copy = bytes.slice();
      const kept = store.setDirty(copy).catch(() => {});
      latest = copy;
      running ??= kept.then(run);
      return running;
    },
  };
}

/** Another tab already holds TabStationToo's cards (its Web Lock): saves would only last in that one. */
export function heldByOtherTab(snapshot: { held?: { name?: string }[]; pending?: unknown[] } | null): boolean {
  return !!snapshot?.held?.some((l) => l.name === LOCK);
}
