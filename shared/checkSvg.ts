// Check artwork in the wallet's style. One SVG used twice: the bot renders it to JPEG
// for Telegram, the Mini App shows it inline, so a check looks the same everywhere.

export const CHECK_IMAGE_WIDTH = 1200;
export const CHECK_IMAGE_HEIGHT = 800;

const LOGO =
  '<path d="M4 3c9 4 18 14 32 34-10-5-19-14-32-34Z" fill="url(#ck-la)"/>' +
  '<path d="M36 3C27 9 20 16 15 22l3 4C23 18 29 10 36 3Z" fill="url(#ck-lb)"/>' +
  '<path d="M4 37c4-6 7-9 9-11l2.5 3.5C12 32 8 35 4 37Z" fill="url(#ck-lb)"/>';

const TETHER =
  '<path d="M6 6.5h12v2.6h-4.6v2c2.6.2 4.6.8 4.6 1.5s-2 1.3-4.6 1.5V19h-2.8v-4.9C8 13.9 6 13.3 6 12.6s2-1.3 4.6-1.5v-2H6Zm4.6 5.5c-1.8.1-3.1.4-3.1.6s1.9.7 4.5.7 4.5-.4 4.5-.7-1.3-.5-3.1-.6v1.2h-2.8Z" fill="#fff"/>';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * @param amount short amount text, e.g. "10" or "2.5"
 * @param fontFamily the bot passes its bundled font; the app uses the page font
 * @param radius corner radius; 0 for Telegram, which rounds photos itself
 */
export function checkSvg(amount: string, fontFamily = 'Manrope', radius = 56): string {
  const W = CHECK_IMAGE_WIDTH;
  const H = CHECK_IMAGE_HEIGHT;
  // Long amounts get a smaller size so "1234567.89" still fits next to the coin.
  const len = amount.length;
  const size = len <= 3 ? 230 : len <= 5 ? 190 : len <= 7 ? 150 : 120;
  const coin = 150;
  const charW = size * 0.6;
  const gap = 34;
  const total = coin + gap + len * charW;
  const x0 = (W - total) / 2;
  const cy = 390;
  const usd = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const pattern = Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => {
      const x = c * 150 + (r % 2) * 75 - 20;
      const y = r * 150 - 30;
      return `<g transform="translate(${x} ${y}) scale(1.4) rotate(-12 20 20)" opacity="0.045">${LOGO.replace(/url\(#ck-l[ab]\)/g, '#fff')}</g>`;
    }).join(''),
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(fontFamily)}, sans-serif">
<defs>
  <linearGradient id="ck-bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0d1118"/><stop offset="0.55" stop-color="#121827"/><stop offset="1" stop-color="#1b2340"/>
  </linearGradient>
  <radialGradient id="ck-glow" cx="0.82" cy="0.12" r="0.75">
    <stop offset="0" stop-color="#6c7bff" stop-opacity="0.45"/><stop offset="1" stop-color="#6c7bff" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="ck-glow2" cx="0.1" cy="1" r="0.6">
    <stop offset="0" stop-color="#2fd18b" stop-opacity="0.22"/><stop offset="1" stop-color="#2fd18b" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="ck-sheen" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="ck-coin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3fc6a0"/><stop offset="1" stop-color="#1a9f7a"/></linearGradient>
  <linearGradient id="ck-la" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f4f6fb"/><stop offset="1" stop-color="#8d96a8"/></linearGradient>
  <linearGradient id="ck-lb" x1="40" y1="0" x2="0" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#dfe6ff"/><stop offset="1" stop-color="#5b6bff"/></linearGradient>
  <clipPath id="ck-clip"><rect width="${W}" height="${H}" rx="${radius}"/></clipPath>
</defs>
<g clip-path="url(#ck-clip)">
  <rect width="${W}" height="${H}" fill="url(#ck-bg)"/>
  <rect width="${W}" height="${H}" fill="url(#ck-glow)"/>
  <rect width="${W}" height="${H}" fill="url(#ck-glow2)"/>
  ${pattern}
  <polygon points="${W * 0.52},0 ${W * 0.7},0 ${W * 0.38},${H} ${W * 0.2},${H}" fill="url(#ck-sheen)"/>
  ${radius ? `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="${radius - 2}" fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="3"/>` : ''}

  <g transform="translate(70 62) scale(1.9)">${LOGO}</g>
  <text x="160" y="118" font-size="50" font-weight="800" fill="#f3f5f9">Crypto <tspan fill="#c9cfdb">IX</tspan></text>
  <rect x="${W - 250}" y="66" width="180" height="64" rx="32" fill="#fff" fill-opacity="0.08" stroke="#fff" stroke-opacity="0.16" stroke-width="2"/>
  <text x="${W - 160}" y="110" font-size="32" font-weight="800" fill="#dfe4ff" text-anchor="middle" letter-spacing="3">ЧЕК</text>

  <g transform="translate(${x0} ${cy - coin / 2})">
    <circle cx="${coin / 2}" cy="${coin / 2}" r="${coin / 2}" fill="url(#ck-coin)"/>
    <circle cx="${coin / 2}" cy="${coin / 2}" r="${coin / 2 - 3}" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="3"/>
    <g transform="translate(${coin * 0.19} ${coin * 0.19}) scale(${(coin * 0.62) / 24})">${TETHER}</g>
  </g>
  <text x="${x0 + coin + gap}" y="${cy + size * 0.36}" font-size="${size}" font-weight="800" fill="#ffffff" letter-spacing="-4">${esc(amount)}</text>

  <text x="${W / 2}" y="${cy + 170}" font-size="58" font-weight="800" fill="#e8ecf6" text-anchor="middle" letter-spacing="2">USDT</text>
  <text x="${W / 2}" y="${cy + 232}" font-size="38" font-weight="600" fill="#8b93a3" text-anchor="middle">≈ $${usd}</text>
  <text x="70" y="${H - 58}" font-size="28" font-weight="600" fill="#8b93a3">Перевод без комиссии</text>
  <text x="${W - 70}" y="${H - 58}" font-size="28" font-weight="600" fill="#8b93a3" text-anchor="end">Secure · Fast · Global</text>
</g>
</svg>`;
}
