import { S3Client } from "bun";

/**
 * A stand-in for R2 (as discs.test.ts' one): objects by key, single PUTs and multipart ones, GET by Range, DELETE, and
 * the list (ListObjectsV2: by prefix, in pages of max-keys). `fail`: the PUTs it refuses (403, never retried).
 */
export function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  const r2 = { fail: null as ((key: string) => boolean) | null };
  const uploads = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
      const q = url.searchParams;
      const ok = (body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { headers: { ETag: '"e"', ...headers } });
      if (req.method === "GET" && q.get("list-type") === "2") {
        const prefix = q.get("prefix") ?? "";
        const after = q.get("continuation-token") ?? "";
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, Number(q.get("max-keys") ?? 1000));
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const more = page.length < all.length;
        return ok(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
            `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${esc(page.at(-1)!)}</NextContinuationToken>` : ""}` +
            page.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.length}</Size><ETag>"e"</ETag></Contents>`).join("") +
            "</ListBucketResult>",
          { "Content-Type": "application/xml" },
        );
      }
      if (req.method === "PUT" && r2.fail?.(key)) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      if (req.method === "POST" && q.has("uploads")) {
        const id = `u${++next}`;
        uploads.set(id, new Map());
        return ok(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT" && q.has("partNumber")) {
        uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
        return ok();
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const parts = uploads.get(q.get("uploadId")!)!;
        const all = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
        objects.set(key, new Uint8Array(await new Blob(all).arrayBuffer()));
        return ok('<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>');
      }
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
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
  return Object.assign(r2, { objects, client, stop: () => server.stop(true) });
}
