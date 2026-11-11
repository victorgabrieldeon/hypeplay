/**
 * The builds' queue for workers on other machines (ps2-builder with QUEUE_URL): they can't open queue.db, so they ask
 * here, under /worker/, with WORKER_TOKEN (Authorization: Bearer). Off without it. All POST, JSON:
 *
 *   claim  { worker, shell, recomp }               → 200 FastClaim (fastjobs.ts), or 204: nothing to build
 *   beat   { worker, key, token, status, log? }    → { ok }: false, the job isn't theirs any more (stop, publish nothing)
 *   done   { worker, key, token, status, shell, recomp, build? }  the build is in R2 (`build`): it's served from there;
 *                                                  without `build`, there was nothing to build
 *   fail   { worker, key, token, status, final }
 *   disc   { key, token }                          → the game's disc, when it's on this disk rather than in R2
 *
 * Only the PS2 games' "versão rápida": BT3's builder only builds here (its disc never goes to R2).
 */
import { timingSafeEqual } from "node:crypto";
import type { S3Client } from "bun";
import { rangeResponse } from "./http";
import { claimFast, fastPaths, finishR2, idOf, LOG_MAX, validR2Build, writeFastLog } from "./fastjobs";
import type { Queue } from "./queue";

const WORKER = /^[\w.:@-]{1,80}$/;

export interface WorkerApiOptions {
  dir: string;
  queue: Queue;
  r2: S3Client | null;
  token: string;
}

export function createWorkerApi({ dir, queue, r2, token }: WorkerApiOptions) {
  const secret = Buffer.from(`Bearer ${token}`);
  const authorized = (req: Request) => {
    const got = Buffer.from(req.headers.get("authorization") ?? "");
    return got.length === secret.length && timingSafeEqual(got, secret);
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const bad = () => json({ error: "Pedido inválido" }, 400);

  async function route(req: Request, path: string): Promise<Response> {
    if (!authorized(req)) return json({ error: "Sem permissão" }, 401);
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return bad();
    const worker = typeof b.worker === "string" && WORKER.test(b.worker) ? b.worker : null;
    if (path === "claim") {
      if (!worker) return bad();
      const image = typeof b.shell === "string" && typeof b.recomp === "string" ? { shell: b.shell, recomp: b.recomp } : undefined;
      const c = await claimFast(dir, queue, worker, image);
      return c ? json(c) : new Response(null, { status: 204 });
    }
    const key = typeof b.key === "string" ? b.key : "";
    const id = idOf(key);
    const tok = typeof b.token === "string" ? b.token : "";
    if (!id || !tok) return bad();
    const status = b.status && typeof b.status === "object" ? (b.status as object) : undefined;
    switch (path) {
      case "beat": {
        const ok = queue.beat(key, tok, status, worker ?? undefined);
        if (ok && typeof b.log === "string") await writeFastLog(dir, id, b.log.slice(-LOG_MAX));
        return json({ ok });
      }
      case "done": {
        const report = { ...(status ? { status } : {}), ...(typeof b.shell === "string" ? { shell: b.shell } : {}), ...(typeof b.recomp === "string" ? { recomp: b.recomp } : {}) };
        // (nothing to build after all: the job done as it was)
        if (b.build === undefined) return json({ ok: !!queue.done(key, tok, report) });
        if (!status || !validR2Build(id, b.build)) return bad();
        return json({ ok: await finishR2(dir, queue, r2, key, tok, b.build, { ...report, status }) });
      }
      case "fail":
        return json({ ok: queue.fail(key, tok, { status, final: b.final !== false }) });
      case "disc": {
        if (!queue.mine(key, tok)) return json({ error: "Esse job não é seu" }, 409);
        const f = Bun.file(fastPaths(dir, id).iso);
        if (!(await f.exists())) return json({ error: "A ISO não está neste disco" }, 404);
        return rangeResponse(req, f, { "Content-Type": "application/octet-stream" }, f.size);
      }
    }
    return json({ error: "Não encontrado" }, 404);
  }

  return {
    /** A /worker/… request answered here; anything else is the app's (null). */
    handle(req: Request): Promise<Response> | null {
      const m = /^\/worker\/([a-z]+)$/.exec(new URL(req.url).pathname);
      return m ? route(req, m[1]!) : null;
    },
  };
}
