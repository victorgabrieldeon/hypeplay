/**
 * "Abrir no navegador": a game (or the home's controller screen) asks the entry page, which holds the Discord SDK, to
 * open it outside Discord (player 2's page with its room, BT3's port too, which runs smoother
 * there), and the library itself opened straight into a game (?play=: "where to play?" answered "in the browser").
 * Inside Discord the page sits behind the *.discordsays.com proxy, so it sends only its path and the entry page puts
 * the app's public address (PUBLIC_URL) in front. The PC app's download too (Discord's frame doesn't download). Only
 * our own pages, never anywhere else.
 */
const PAGES =
  /^\/p\/[\w.-]+\/(?:\?play=(?:bt3|ps2%2F[a-z]{4}-\d{5}(?:-\d{1,2})?)(?:&join=[A-Z2-9]{4,6}(?:&watch=1)?|&fast=1(?:&online=1)?|&online=1)?|ps2\/[a-z]{4}-\d{5}(?:-\d{1,2})?\/(?:game\/|fast\/|watch\/\?room=[A-Z2-9]{6}(?:&watch=1)?)|bt3\/game\/|app\/(?:linux|windows))?$/;

export function openRequest(data: unknown, publicUrl: string): string | null {
  if (!publicUrl || !data || typeof data !== "object") return null;
  const { t, path } = data as { t?: unknown; path?: unknown };
  if (t !== "cordplay:open" || typeof path !== "string" || !PAGES.test(path)) return null;
  return publicUrl + path;
}
