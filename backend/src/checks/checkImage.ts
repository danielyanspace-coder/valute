import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSvg } from '../../../shared/checkSvg.js';

// Fonts ship with the repo (backend/assets, SIL OFL), so rendering does not depend on system fonts.
// The folder is two levels up from src/checks and four from dist/backend/src/checks.
const FONT_NAMES = ['Manrope-ExtraBold.ttf', 'Manrope-SemiBold.ttf'];
const fontFiles =
  ['../../assets', '../../../../assets']
    .map((rel) => FONT_NAMES.map((f) => fileURLToPath(new URL(`${rel}/${f}`, import.meta.url))))
    .find((files) => files.every((f) => existsSync(f))) ?? [];

const cache = new Map<string, Buffer>();
const CACHE_LIMIT = 500;

/** JPEG of a check for a short amount like "10" (Telegram accepts only JPEG for inline photo results). */
export function renderCheckJpeg(amount: string): Buffer {
  const hit = cache.get(amount);
  if (hit) return hit;
  const r = new Resvg(checkSvg(amount, 'Manrope', 0), {
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Manrope' },
    background: '#0d1118',
  }).render();
  const out = jpeg.encode({ data: r.pixels, width: r.width, height: r.height }, 88).data;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(amount, out);
  return out;
}
