/**
 * The PS2 games' memory cards, one per game and person, under saves/<game>/<discord id>.ps2: the activity's frame keeps
 * no browser storage, and this way a save follows its owner to any computer. With R2 (S3_BUCKET) the card lives there,
 * under that same key, and the one from before the latest session under <key>.prev; a card still on this disk goes up
 * the first time it's read. Without R2, on this disk, written whole through a temporary file, so a write cut short
 * never leaves half a card.
 *
 * Only "there is no card" answers null: any other failure throws, so the page never takes it for a blank card and
 * saves over the real one (page/cardsync.ts).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { ID } from "./library";

/** An 8 MB PS2 memory card with its ECC, in the layout PCSX2 and the game page use. */
export const CARD_BYTES = 8_650_752;
export const CARD_MAGIC = "Sony PS2 Memory Card Format ";
export const USER = /^[\w-]{1,40}$/;
const PREV_AFTER_MS = 10 * 60_000;

export function createSaves(dir: string, client: S3Client | null = null) {
  const key = (game: string, user: string) => (ID.test(game) && USER.test(user) ? `saves/${game}/${user}.ps2` : null);

  async function local(k: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      return Uint8Array.from(await readFile(join(dir, k)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    async get(game: string, user: string): Promise<Uint8Array<ArrayBuffer> | null> {
      const k = key(game, user);
      if (!k) return null;
      if (!client) return local(k);
      const f = client.file(k);
      if (await f.exists()) return f.bytes();
      // (a card saved before R2: up it goes, then it's read from there)
      const here = await local(k);
      if (here) await client.write(k, here);
      return here;
    },

    async put(game: string, user: string, body: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }> {
      const k = key(game, user);
      if (!k) return { ok: false, error: "Pedido inválido" };
      if (body.length !== CARD_BYTES || new TextDecoder().decode(body.subarray(0, CARD_MAGIC.length)) !== CARD_MAGIC)
        return { ok: false, error: "Isso não é um memory card de PS2" };
      if (client) {
        // the card as it was before this session stays as <key>.prev, to bring back by hand a save that went bad (not
        // the one sent seconds ago: a game's save often goes up halfway first, then whole)
        const f = client.file(k);
        if ((await f.exists()) && Date.now() - (await f.stat()).lastModified.getTime() > PREV_AFTER_MS)
          await client.write(`${k}.prev`, await f.bytes());
        await client.write(k, body);
        return { ok: true };
      }
      const p = join(dir, k);
      await mkdir(join(dir, "saves", game), { recursive: true });
      await writeFile(`${p}.tmp`, body);
      await rename(`${p}.tmp`, p);
      return { ok: true };
    },
  };
}

export type Saves = ReturnType<typeof createSaves>;
