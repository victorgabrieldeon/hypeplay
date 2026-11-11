/**
 * Game covers: the one someone sent, made a 600×900 WebP (2:3, a PS2 case) so every cover in the library is the same
 * shape and size; or, without one, a drawing made here from the serial: geometric shapes in the brand's purples and the
 * game's name, the same every time for the same game. Never anyone's logo or art.
 *
 * sharp (a native module) is loaded on the first cover sent, not at startup: the server never depends on it to run.
 * Where it can't load at all (no native build for the machine, a path too long for Windows), a cover goes as sent.
 */
import { log } from "./log";

export const COVER_MAX = 5 * 1024 ** 2;
/** The drawing's version: covers are kept a year by address, so a new drawing needs new addresses. */
export const COVER_ART = 2;
const FORMATS = new Set(["png", "jpeg", "webp"]);

/** A PNG, JPG or WebP's type, from its first bytes; null for anything else. */
export function imageType(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

type Sharp = typeof import("sharp").default;

export async function normalizeCover(
  body: Uint8Array,
  load: () => Promise<{ default: Sharp }> = () => import("sharp"),
): Promise<{ ok: true; image: Uint8Array } | { ok: false; error: string }> {
  if (body.length > COVER_MAX) return { ok: false, error: "A capa pode ter até 5 MB" };
  const wrong = { ok: false as const, error: "A capa precisa ser PNG, JPG ou WebP" };
  let sharp: Sharp;
  try {
    sharp = (await load()).default;
  } catch (err) {
    log.warn("covers go as sent: sharp didn't load", { error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    return imageType(body) ? { ok: true, image: body } : wrong;
  }
  try {
    const meta = await sharp(body).metadata();
    if (!meta.format || !FORMATS.has(meta.format)) return wrong;
    const webp = await sharp(body).rotate().resize(600, 900, { fit: "cover", position: "attention" }).webp({ quality: 82 }).toBuffer();
    return { ok: true, image: new Uint8Array(webp) };
  } catch {
    return wrong;
  }
}

/** FNV-1a: small, stable, enough to pick shapes and a hue. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Up to 3 lines of about 18 characters, on word boundaries. */
function lines(name: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of name.trim().split(/\s+/)) {
    if (line && (line + " " + word).length > 18) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length > 3) out.splice(2, out.length, `${out.slice(2).join(" ").slice(0, 16)}…`);
  return out;
}

/** What changes a drawn cover's picture (the drawing, the serial, the name): part of its address. */
export const coverVersion = (serial: string, name: string) => `g${COVER_ART}-${hash(`${serial}\n${name}`).toString(36)}`;

/** A point on a circle of radius r, at `deg` degrees (0 = right, clockwise). */
const at = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
};

/**
 * A disc in the game's own color (blue to magenta, from the serial) sliding off the cover, its rings and a gloss, on
 * a dark case with a spine carrying the serial; the name at the bottom.
 */
export function generatedCover(serial: string, name: string): string {
  const h = hash(serial);
  const hue = 200 + (h % 140);
  const r = 250 + ((h >>> 8) % 90);
  const cx = 330 + ((h >>> 12) % 220);
  const cy = 300 + ((h >>> 16) % 220);
  const turn = (h >>> 20) % 180;
  const gloss = 200 + ((h >>> 24) % 60);
  const tint = (dh: number, s: number, l: number) => `hsl(${(hue + dh + 360) % 360} ${s}% ${l}%)`;
  const rings = [0.92, 0.82, 0.72, 0.62, 0.52].map((k) => `<circle r="${Math.round(r * k)}"/>`).join("");
  const text = lines(name)
    .map((l, i, all) => `<text x="48" y="${828 - (all.length - 1 - i) * 52}">${xml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${tint(0, 55, 17)}"/><stop offset="0.75" stop-color="#0b0a14"/></linearGradient>
<linearGradient id="foil" gradientTransform="rotate(${turn} .5 .5)"><stop offset="0" stop-color="${tint(0, 95, 66)}"/><stop offset="0.35" stop-color="${tint(45, 90, 72)}"/><stop offset="0.65" stop-color="${tint(-40, 90, 60)}"/><stop offset="1" stop-color="${tint(20, 95, 76)}"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${tint(0, 100, 60)}" stop-opacity="0.5"/><stop offset="1" stop-color="${tint(0, 100, 60)}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="#0b0a14" stop-opacity="0"/><stop offset="0.96" stop-color="#0b0a14"/></linearGradient></defs>
<rect width="600" height="900" fill="url(#bg)"/>
<circle cx="${cx}" cy="${cy}" r="${Math.round(r * 1.6)}" fill="url(#glow)"/>
<g transform="translate(${cx} ${cy})">
<circle r="${r}" fill="url(#foil)"/>
<g fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="2">${rings}</g>
<path d="M0 0L${at(r, gloss)}A${r} ${r} 0 0 1 ${at(r, gloss + 28)}Z" fill="#fff" opacity="0.22"/>
<path d="M0 0L${at(r, gloss + 180)}A${r} ${r} 0 0 1 ${at(r, gloss + 196)}Z" fill="#fff" opacity="0.12"/>
<circle r="${Math.round(r * 0.36)}" fill="#0b0a14" opacity="0.5"/>
<circle r="${Math.round(r * 0.3)}" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="3"/>
<circle r="${Math.round(r * 0.11)}" fill="#0b0a14"/>
</g>
<rect width="600" height="900" fill="url(#fade)"/>
<rect width="600" height="72" fill="#0b0a14" opacity="0.78"/>
<rect y="72" width="600" height="2" fill="${tint(0, 95, 70)}" opacity="0.6"/>
<text x="40" y="45" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="22" letter-spacing="2" fill="#a3a1bd">${xml(serial)}</text>
<text x="560" y="45" text-anchor="end" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="800" font-size="22" letter-spacing="3" fill="${tint(0, 95, 76)}">PS2</text>
<rect x="48" y="${828 - (lines(name).length - 1) * 52 - 64}" width="56" height="6" rx="3" fill="${tint(0, 95, 70)}"/>
<g font-family="Unbounded, ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="42" fill="#f3f2fb">${text}</g>
</svg>`;
}
