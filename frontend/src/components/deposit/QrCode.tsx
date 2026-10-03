import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * QR with rounded modules and a Tether badge in the middle. Error correction "H"
 * keeps it readable with the centre covered.
 */
export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const { cells, n } = useMemo(() => {
    const qr = qrcode(0, 'H');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const out: [number, number][] = [];
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) out.push([r, c]);
    return { cells: out, n: count };
  }, [value]);

  const quiet = 2;
  const total = n + quiet * 2;
  const isFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const logo = Math.round(n * 0.26);
  const lo = (n - logo) / 2;
  const inLogo = (r: number, c: number) => r >= lo - 0.5 && r < lo + logo + 0.5 && c >= lo - 0.5 && c < lo + logo + 0.5;
  const finders: [number, number][] = [[0, 0], [0, n - 7], [n - 7, 0]];

  return (
    <svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${total} ${total}`} className="qr" role="img" aria-label="QR-код адреса">
      <rect x={-quiet} y={-quiet} width={total} height={total} rx={3} fill="#fff" />
      {cells
        .filter(([r, c]) => !isFinder(r, c) && !inLogo(r, c))
        .map(([r, c]) => (
          <rect key={`${r}-${c}`} x={c + 0.08} y={r + 0.08} width={0.84} height={0.84} rx={0.32} fill="#0d1118" />
        ))}
      {finders.map(([r, c]) => (
        <g key={`f${r}${c}`}>
          <rect x={c + 0.5} y={r + 0.5} width={6} height={6} rx={1.8} fill="none" stroke="#0d1118" strokeWidth={1} />
          <rect x={c + 2} y={r + 2} width={3} height={3} rx={0.9} fill="#1a9f7a" />
        </g>
      ))}
      <g transform={`translate(${lo} ${lo})`}>
        <circle cx={logo / 2} cy={logo / 2} r={logo / 2 + 0.6} fill="#fff" />
        <circle cx={logo / 2} cy={logo / 2} r={logo / 2} fill="#26a17b" />
        <g transform={`translate(${logo * 0.19} ${logo * 0.19}) scale(${(logo * 0.62) / 24})`}>
          <path
            d="M6 6.5h12v2.6h-4.6v2c2.6.2 4.6.8 4.6 1.5s-2 1.3-4.6 1.5V19h-2.8v-4.9C8 13.9 6 13.3 6 12.6s2-1.3 4.6-1.5v-2H6Zm4.6 5.5c-1.8.1-3.1.4-3.1.6s1.9.7 4.5.7 4.5-.4 4.5-.7-1.3-.5-3.1-.6v1.2h-2.8Z"
            fill="#fff"
          />
        </g>
      </g>
    </svg>
  );
}
