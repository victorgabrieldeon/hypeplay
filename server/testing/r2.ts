import { S3Client } from "bun";

/**
 * A stand-in for R2 (as discs.test.ts' one): objects by key, single PUTs and multipart ones, GET by Range, DELETE.
 * `partDelay`: each part waits this long before it's taken (a slow link); `received`: the parts' bytes taken so far,
 * `written`: how many objects were written.
 */
export function fakeR2({ partDelay = 0 } = {}) {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  const counts = { received: 0, written: 0 };
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
      const q = url.searchParams;
      const ok = (body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { headers: { ETag: '"e"', ...headers } });
      if (req.method === "POST" && q.has("uploads")) {
        const id = `u${++next}`;
        uploads.set(id, new Map());
        return ok(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT" && q.has("partNumber")) {
        const part = new Uint8Array(await req.arrayBuffer());
        if (partDelay) await Bun.sleep(partDelay);
        uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), part);
        counts.received += part.length;
        return ok();
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const parts = uploads.get(q.get("uploadId")!)!;
        const all = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
        objects.set(key, new Uint8Array(await new Blob(all).arrayBuffer()));
        counts.written++;
        return ok('<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>');
      }
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        counts.written++;
        return ok();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const data = objects.get(key);
      if (!data) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
      const [a, b] = m ? [Number(m[1]), Math.min(Number(m[2]), data.length - 1)] : [0, data.length - 1];
      return ok(req.method === "HEAD" ? null : data.slice(a, b + 1), { "Content-Length": String(b - a + 1) });
    },
  });
  const client = new S3Client({ accessKeyId: "k", secretAccessKey: "s", bucket: "bucket", endpoint: `http://127.0.0.1:${server.port}` });
  return {
    objects,
    client,
    get received() {
      return counts.received;
    },
    get written() {
      return counts.written;
    },
    stop: () => server.stop(true),
  };
}
