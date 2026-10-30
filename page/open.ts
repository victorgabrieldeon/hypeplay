/**
 * "Abrir no navegador": a game (or the home's controller screen) asks the entry page, which holds the Discord SDK, to
 * open it outside Discord. Inside Discord the page sits behind the *.discordsays.com proxy, so it sends only its path
 * and the entry page puts the app's public address (PUBLIC_URL) in front. Only our own pages, never anywhere else.
 */
const PAGES = /^\/p\/[\w.-]+\/(?:ps2\/[a-z]{4}-\d{5}\/game\/)?$/;

export function openRequest(data: unknown, publicUrl: string): string | null {
  if (!publicUrl || !data || typeof data !== "object") return null;
  const { t, path } = data as { t?: unknown; path?: unknown };
  if (t !== "cordplay:open" || typeof path !== "string" || !PAGES.test(path)) return null;
  return publicUrl + path;
}
