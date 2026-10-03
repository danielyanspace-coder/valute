// Downloads SBP bank logos from the NSPK participants list and stores them
// as 72×72 PNGs in frontend/src/assets/banks/<nspk id>.png.
//   node scripts/fetch-bank-logos.mjs            (download from NSPK)
//   node scripts/fetch-bank-logos.mjs <dir>      (use already downloaded <id>.png files)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');

const SIZE = 72; // shown at 36px, so sharp on 2x screens
const OUT = new URL('../frontend/src/assets/banks/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// NSPK serves most logos as PNG, a few as JPEG under a .png name: sniff the real type.
const mime = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png');

function resize(img) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <image href="data:${mime(img)};base64,${img.toString('base64')}" width="${SIZE}" height="${SIZE}"/></svg>`;
  return new Resvg(svg).render().asPng();
}

async function download() {
  const list = await (await fetch('https://qr.nspk.ru/proxyapp/c2bmembers.json')).json();
  const result = new Map();
  for (const bank of list.dictionary) {
    const id = bank.schema.replace('bank', '');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(bank.logoURL, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(String(res.status));
        result.set(id, Buffer.from(await res.arrayBuffer()));
        break;
      } catch (err) {
        if (attempt === 3) console.warn(`skip ${id} ${bank.bankName}: ${err.message}`);
      }
    }
  }
  return result;
}

const sourceDir = process.argv[2];
const logos = sourceDir
  ? new Map(readdirSync(sourceDir).filter((f) => f.endsWith('.png')).map((f) => [f.replace('.png', ''), readFileSync(`${sourceDir}/${f}`)]))
  : await download();

let n = 0;
for (const [id, png] of logos) {
  try {
    writeFileSync(new URL(`${id}.png`, OUT), resize(png));
    n++;
  } catch (err) {
    console.warn(`bad image ${id}: ${err.message}`);
  }
}
console.log(`saved ${n} logos to frontend/src/assets/banks`);
