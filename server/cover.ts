/**
 * Game covers: the one someone sent, made a 600×900 WebP (2:3, a PS2 case) so every cover in the library is the same
 * shape and size; or, without one, a drawing made here from the serial: geometric shapes in the brand's purples and the
 * game's name, the same every time for the same game. Never anyone's logo or art.
 */
import sharp from "sharp";

export const COVER_MAX = 5 * 1024 ** 2;
const FORMATS = new Set(["png", "jpeg", "webp"]);

export async function normalizeCover(body: Uint8Array): Promise<{ ok: true; webp: Uint8Array } | { ok: false; error: string }> {
  if (body.length > COVER_MAX) return { ok: false, error: "A capa pode ter até 5 MB" };
  const wrong = { ok: false as const, error: "A capa precisa ser PNG, JPG ou WebP" };
  try {
    const meta = await sharp(body).metadata();
    if (!meta.format || !FORMATS.has(meta.format)) return wrong;
    const webp = await sharp(body).rotate().resize(600, 900, { fit: "cover", position: "attention" }).webp({ quality: 82 }).toBuffer();
    return { ok: true, webp: new Uint8Array(webp) };
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

export function generatedCover(serial: string, name: string): string {
  const h = hash(serial);
  const hue = (h % 60) + 245;
  const r = 180 + (h >>> 8) % 160;
  const cx = 120 + ((h >>> 12) % 360);
  const cy = 140 + ((h >>> 16) % 260);
  const turn = (h >>> 20) % 360;
  const text = lines(name)
    .map((l, i, all) => `<text x="48" y="${828 - (all.length - 1 - i) * 52}">${xml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 100% 66%)"/><stop offset="1" stop-color="#a08cff"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#0b0a14" stop-opacity="0"/><stop offset="1" stop-color="#0b0a14"/></linearGradient></defs>
<rect width="600" height="900" fill="#0b0a14"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g)" opacity="0.9"/>
<polygon points="0,-260 225,130 -225,130" transform="translate(${600 - cx * 0.6} ${cy + 260}) rotate(${turn})" fill="none" stroke="url(#g)" stroke-width="28" opacity="0.7"/>
<rect width="600" height="900" fill="url(#fade)"/>
<g font-family="'Space Grotesk', ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="44" fill="#f3f2fb">${text}</g>
<text x="48" y="80" font-family="ui-monospace, monospace" font-size="20" fill="#a3a1bd">${xml(serial)}</text>
</svg>`;
}
