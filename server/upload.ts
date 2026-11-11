/**
 * A PS2 game's disc image upload and its state, from the files in its folder (/app/data/ps2/<id>/):
 *
 *   upload/disc.iso.part, upload/state.json   an upload under way ({ size, received, by, at })
 *   disc.iso                                  the whole image (or disc.iso.r2, once moved to R2: discs.ts)
 *
 * One upload at a time, in pieces, each starting exactly where the last one ended, so a dropped connection picks up
 * from the last piece taken. Someone else may take over an upload only after it went quiet.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { markOf, NO_ROOM } from "./discs";
import { join } from "node:path";
import type { Pass } from "./pass";

const MIN_ISO = 1024 ** 3;
const MAX_ISO = 9 * 1024 ** 3;
/** The page sends 32 MiB; a little room above that. */
export const MAX_PIECE = 40 * 1024 ** 2;
/** An upload quiet for this long is taken as gone. */
export const QUIET_MS = 2 * 60_000;

interface UploadState {
  size: number;
  received: number;
  by: { id: string; name: string };
  at: number;
}

export type Status =
  | { state: "empty" }
  | { state: "uploading"; received: number; size: number; by: string; mine: boolean; stale: boolean }
  | { state: "ready" }
  /** the disc is in; the server still needs the PS2 BIOS */
  | { state: "needs-bios" };

export type PutResult =
  | { ok: true; received: number; done: boolean }
  | { ok: false; status: number; code: "done" | "size" | "busy" | "order" | "gone" | "space"; error: string; received?: number };

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const exists = (path: string) => stat(path).then((s) => s, () => null);

export interface DiscStoreOptions {
  now?: () => number;
  /** Accepted image sizes and the largest piece (smaller in tests). */
  min?: number;
  max?: number;
  maxPiece?: number;
  /** Whether the game is still there when a piece has arrived (the PS2 library: it may be removed meanwhile). */
  alive?: () => Promise<boolean>;
  /** Whether an image this big fits on the disk (discs.ts' hasRoom): asked before its first piece. */
  room?: (bytes: number) => Promise<boolean>;
}

export function createDiscStore(dir: string, { now = () => Date.now(), min = MIN_ISO, max = MAX_ISO, maxPiece = MAX_PIECE, alive, room }: DiscStoreOptions = {}) {
  const paths = {
    part: join(dir, "upload", "disc.iso.part"),
    state: join(dir, "upload", "state.json"),
    iso: join(dir, "disc.iso"),
  };
  // One piece at a time, whoever sends it.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const readUpload = () => readJsonFile<UploadState>(paths.state);
  /** The image, here or moved to R2 (its mark, discs.ts). */
  const hasIso = () => exists(paths.iso).then((s) => s ?? exists(markOf(paths.iso)));

  return {
    paths,

    /** How much of the image the server has, for picking an upload up where it stopped. */
    async progress(): Promise<{ received: number; size: number | null; done: boolean }> {
      if (await hasIso()) return { received: 0, size: null, done: true };
      const up = await readUpload();
      return { received: up?.received ?? 0, size: up?.size ?? null, done: false };
    },

    put(pass: Pass, offset: number, size: number, body: Uint8Array): Promise<PutResult> {
      return serial(async () => {
        // (removed while this piece was on its way: don't bring its folder back)
        if (alive && !(await alive())) return { ok: false, status: 404, code: "gone", error: "Esse jogo foi removido" };
        if (await hasIso()) return { ok: false, status: 409, code: "done", error: "O servidor já tem a ISO" };
        if (!Number.isSafeInteger(size) || size < min || size > max)
          return { ok: false, status: 400, code: "size", error: "Esse arquivo não parece a ISO do jogo (tamanho fora do esperado)" };
        if (body.length > maxPiece) return { ok: false, status: 413, code: "size", error: "Pedaço grande demais" };
        let up = await readUpload();
        const t = now();
        if (up && up.by.id !== pass.id && t - up.at < QUIET_MS)
          return { ok: false, status: 409, code: "busy", error: `${up.by.name} está enviando a ISO`, received: up.received };
        // Another file (or a different one picked after a reload): from the start.
        if (up && up.size !== size) {
          await rm(paths.part, { force: true });
          up = null;
        }
        const received = up?.received ?? 0;
        if (offset !== received) return { ok: false, status: 409, code: "order", error: "Fora de ordem", received };
        if (received + body.length > size || (!body.length && received < size))
          return { ok: false, status: 400, code: "order", error: "Pedaço fora do arquivo", received };
        if (!received && room && !(await room(size))) return { ok: false, status: 507, code: "space", error: NO_ROOM };
        await mkdir(join(dir, "upload"), { recursive: true });
        const file = await open(paths.part, received ? "r+" : "w");
        try {
          await file.write(body, 0, body.length, received);
          await file.truncate(received + body.length);
        } finally {
          await file.close();
        }
        const next: UploadState = { size, received: received + body.length, by: { id: pass.id, name: pass.name }, at: t };
        if (next.received < size) {
          await writeFile(paths.state, JSON.stringify(next));
          return { ok: true, received: next.received, done: false };
        }
        await rename(paths.part, paths.iso);
        await rm(join(dir, "upload"), { recursive: true, force: true });
        return { ok: true, received: next.received, done: true };
      });
    },

    async status(pass: Pass): Promise<Status> {
      if (await hasIso()) return { state: "ready" };
      const up = await readUpload();
      if (!up) return { state: "empty" };
      return { state: "uploading", received: up.received, size: up.size, by: up.by.name, mine: up.by.id === pass.id, stale: now() - up.at >= QUIET_MS };
    },
  };
}

export type DiscStore = ReturnType<typeof createDiscStore>;
