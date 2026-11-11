/**
 * Where a ps2-builder worker takes its jobs from (builder.ts' Jobs):
 *
 *   localJobs    this machine: the queue's file and the app's volume, straight (server/fastjobs.ts)
 *   remoteJobs   another machine: the app's /worker/ (server/workers.ts) for the job, R2 for the disc and the build
 *
 * jobsFromEnv picks: QUEUE_URL (the app's address) and WORKER_TOKEN make a remote worker, which needs R2 (S3_*).
 */
import { hostname } from "node:os";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { fetchFromR2, r2FromEnv } from "../server/discs";
import { claimFast, fastPaths, finishLocal, LOG_MAX, PUBLISHED, writeFastLog, type FastClaim } from "../server/fastjobs";
import { createQueue, type Queue, type R2Build } from "../server/queue";
import type { Jobs } from "./builder";

const exists = (path: string) => stat(path).then(() => true, () => false);

export function localJobs({ data, queue, r2, worker }: { data: string; queue: Queue; r2: S3Client | null; worker: string }): Jobs {
  const of = (c: FastClaim) => [c.job.key, c.job.token] as const;
  return {
    claim: (image) => claimFast(data, queue, worker, image),
    beat: async (c, status) => queue.beat(...of(c), status, worker),
    log: (c, text) => void writeFastLog(data, c.game.id, text),
    async disc(c) {
      const iso = fastPaths(data, c.game.id).iso;
      if (await exists(iso)) return { path: iso, release: async () => {} };
      // (a disc in R2: here for port.sh while it builds, gone again after)
      if (!r2) throw new Error("A ISO está no R2 e este worker não tem o R2 (S3_BUCKET)");
      await fetchFromR2(r2, data, iso, iso);
      return { path: iso, release: () => rm(iso, { force: true }) };
    },
    finish: async (c, report, web) => (web ? finishLocal(data, queue, r2, ...of(c), web, report) : !!queue.done(...of(c), report)),
    fail: async (c, status, final) => void queue.fail(...of(c), { status, final }),
  };
}

/** A file to R2 in parts (one PUT stops at 5 GiB; discs.ts' moveToR2 does the same). */
async function put(r2: S3Client, key: string, path: string) {
  const w = r2.file(key).writer({ partSize: 64 * 1024 ** 2, queueSize: 4, retry: 3 });
  for await (const chunk of Bun.file(path).stream()) await w.write(chunk);
  await w.end();
}

export interface RemoteOptions {
  /** The app's address (https://…), where /worker/ answers. */
  url: string;
  token: string;
  r2: S3Client;
  worker: string;
  /** This machine's folder: the disc while it builds (ps2/<id>/disc.iso), next to ps2-work/. */
  data: string;
  fetch?: typeof fetch;
}

export function remoteJobs({ url, token, r2, worker, data, fetch: get = fetch }: RemoteOptions): Jobs {
  const base = url.replace(/\/+$/, "");
  const logs = new Map<string, string>();
  async function call(path: string, body: object): Promise<Response> {
    const res = await get(`${base}/worker/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ worker, ...body }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`${path}: ${res.status} ${await res.text().catch(() => "")}`.trim());
    return res;
  }
  const ok = async (path: string, body: object) => ((await (await call(path, body)).json()) as { ok: boolean }).ok;
  const of = (c: FastClaim) => ({ key: c.job.key, token: c.job.token });
  return {
    async claim(image) {
      const res = await call("claim", image);
      return res.status === 204 ? null : ((await res.json()) as FastClaim);
    },
    // (the app unreachable for a moment: still ours, the lease says for how long)
    beat: (c, status) => ok("beat", { ...of(c), status, log: logs.get(c.job.key) }).catch((err) => (console.error("ps2-builder: beat:", err), true)),
    // (its end only: port.sh says megabytes over a build, and the app keeps no more)
    log: (c, text) => void logs.set(c.job.key, text.slice(-LOG_MAX)),
    async disc(c) {
      const iso = fastPaths(data, c.game.id).iso;
      await mkdir(join(iso, ".."), { recursive: true });
      if (c.game.disc === "r2") await fetchFromR2(r2, data, iso, iso);
      else {
        // (a disc that never went to R2: from the app's disk)
        await Bun.write(`${iso}.part`, await call("disc", of(c)));
        await rename(`${iso}.part`, iso);
      }
      return { path: iso, release: () => rm(iso, { force: true }) };
    },
    async finish(c, report, web) {
      logs.delete(c.job.key);
      if (!web) return ok("done", { ...of(c), ...report });
      // (a prefix of its own, so the build playing now stays whole until the app points at this one)
      const build: R2Build = { prefix: `ps2/${c.game.id}/fast/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, files: [] };
      for (const f of PUBLISHED.flatMap((f) => [f, `${f}.gz`])) {
        if (!(await exists(join(web, f)))) continue;
        await put(r2, `${build.prefix}/${f}`, join(web, f));
        build.files.push(f);
      }
      if (await ok("done", { ...of(c), ...report, build })) return true;
      await Promise.all(build.files.map((f) => r2.file(`${build.prefix}/${f}`).delete().catch(() => undefined)));
      return false;
    },
    async fail(c, status, final) {
      logs.delete(c.job.key);
      await ok("fail", { ...of(c), status, final });
    },
  };
}

/** The jobs this worker takes, from its env; `where` for the log. */
export function jobsFromEnv(data: string, env = process.env): { jobs: Jobs; where: string } {
  const worker = env.WORKER_ID || `${hostname()}-${process.pid}`;
  const r2 = r2FromEnv(env);
  if (env.QUEUE_URL) {
    if (!env.WORKER_TOKEN) throw new Error("QUEUE_URL without WORKER_TOKEN");
    if (!r2) throw new Error("QUEUE_URL without S3_BUCKET: a worker elsewhere publishes its builds in R2");
    return { jobs: remoteJobs({ url: env.QUEUE_URL, token: env.WORKER_TOKEN, r2, worker, data }), where: `${env.QUEUE_URL} (${worker})` };
  }
  return { jobs: localJobs({ data, queue: createQueue(join(data, "queue.db")), r2, worker }), where: `${join(data, "queue.db")} (${worker})` };
}
