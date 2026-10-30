/**
 * The PS2 games' memory cards, one per game and person, in saves/<game>/<discord id>.ps2: the activity's frame keeps
 * no browser storage, and this way a save follows its owner to any computer. Written whole, through a temporary file,
 * so a write cut short never leaves half a card.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ID } from "./library";

/** An 8 MB PS2 memory card with its ECC, in the layout PCSX2 and the game page use. */
export const CARD_BYTES = 8_650_752;
export const CARD_MAGIC = "Sony PS2 Memory Card Format ";
export const USER = /^[\w-]{1,40}$/;

export function createSaves(dir: string) {
  const path = (game: string, user: string) => (ID.test(game) && USER.test(user) ? join(dir, "saves", game, `${user}.ps2`) : null);

  return {
    async get(game: string, user: string): Promise<Uint8Array<ArrayBuffer> | null> {
      const p = path(game, user);
      if (!p) return null;
      return readFile(p).then((b) => Uint8Array.from(b), () => null);
    },

    async put(game: string, user: string, body: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }> {
      const p = path(game, user);
      if (!p) return { ok: false, error: "Pedido inválido" };
      if (body.length !== CARD_BYTES || new TextDecoder().decode(body.subarray(0, CARD_MAGIC.length)) !== CARD_MAGIC)
        return { ok: false, error: "Isso não é um memory card de PS2" };
      await mkdir(join(dir, "saves", game), { recursive: true });
      await writeFile(`${p}.tmp`, body);
      await rename(`${p}.tmp`, p);
      return { ok: true };
    },
  };
}

export type Saves = ReturnType<typeof createSaves>;
