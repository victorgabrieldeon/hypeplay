// The disc's address on the optional edge (edge/worker.ts), which the server puts in the emulator's page when there's
// one and the disc is in R2 (<meta name="hypeplay-disc">, server/routes.ts). Only inside Discord: there it's a path of
// the page's own origin (an URL Mapping of <client id>.discordsays.com to the Worker); in a browser tab of its own that
// path is the app's server, which doesn't serve it. Otherwise null, and the page reads disc.iso from the server as
// before. The disc keeps its name (/ps2/<id>/game/disc.iso, page/disccache.ts' discPath): the blocks already on the
// browser's disk, the panel's "Baixar tudo" (perf.ts) and the versão rápida's (fastdisc.ts) are the same.

export function edgeDisc(doc: Pick<Document, "querySelector"> = document, host = location.hostname): string | null {
  const url = doc.querySelector<HTMLMetaElement>('meta[name="hypeplay-disc"]')?.content ?? "";
  return /(^|\.)discordsays\.com$/.test(host) && /^\/[^/]/.test(url) ? url : null;
}
