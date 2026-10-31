// The pipeline list between this browser and the server (pipelines.ts), for ps2play.ts: before TabStationToo's app.js
// starts, the server's list joins this browser's, in the emulator's own IndexedDB record (it hands that to the renderer
// once it knows the game); while playing, what this browser adds goes back to the server now and then.
import { decodeList, encodeList, mergeLists, type PipeList } from "./pipelines";

// TabStationToo's (app.js "pipeline lists"): a record per game serial, { version: [lo, hi], keys, savedAt }
const DB = "pcsx2-web-pipelines";
const STORE = "tfx";
const SEND_MS = 60_000;

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function local(serial: string, write?: PipeList): Promise<PipeList | null> {
  const db = await idb();
  try {
    return await new Promise((ok, fail) => {
      const tx = db.transaction(STORE, write ? "readwrite" : "readonly");
      const s = tx.objectStore(STORE);
      let rec: { version?: unknown; keys?: unknown } | undefined;
      if (write) s.put({ version: write.version, keys: write.keys.slice().buffer, savedAt: Date.now() }, serial);
      else s.get(serial).onsuccess = (e) => (rec = (e.target as IDBRequest).result);
      tx.oncomplete = () =>
        ok(Array.isArray(rec?.version) && rec.keys instanceof ArrayBuffer ? { version: rec.version as [number, number], keys: new Uint8Array(rec.keys) } : null);
      tx.onerror = () => fail(tx.error);
    });
  } finally {
    db.close();
  }
}

const same = (a: PipeList | null, b: PipeList | null) =>
  !!a && !!b && a.version[0] === b.version[0] && a.version[1] === b.version[1] && a.keys.length === b.keys.length;

/** Before the emulator starts: the server's list (`url`) and this browser's, together. A slow server isn't waited on. */
export async function syncPipelines(serial: string, url = "pipelines"): Promise<void> {
  const quiet = new Promise<null>((ok) => setTimeout(() => ok(null), 3000));
  const fromServer = fetch(url, { cache: "no-store" })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? decodeList(new Uint8Array(b)) : null))
    .catch(() => null);
  const server = await Promise.race([fromServer, quiet]);
  const mine = await local(serial).catch(() => null);
  // (the server's first: its keys are its emulator's, and a list an older build left in this browser doesn't mix in)
  const both = mergeLists(server, mine);
  if (both && !same(both, mine)) await local(serial, both).catch(() => {});
  let sent = server;
  const send = async () => {
    const now = await local(serial).catch(() => null);
    if (!now || same(now, sent)) return;
    const r = await fetch(url, { method: "PUT", body: encodeList(now) }).catch(() => null);
    if (r?.ok) sent = now;
  };
  setInterval(send, SEND_MS);
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void send());
}
