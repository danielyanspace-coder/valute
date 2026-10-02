import { useId } from 'react';

interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  dots?: boolean;
}

export function Sparkline({ values, width = 300, height = 80, color = 'var(--green)', dots = false }: Props) {
  const id = useId();
  if (values.length < 2) return <svg width={width} height={height} />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * (width - pad * 2) + pad,
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts.at(-1)![0]},${height} L${pts[0][0]},${height} Z`;
  const step = Math.max(1, Math.floor(values.length / 8));

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="sparkline">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} stroke={color} strokeWidth="1.6" fill="none" vectorEffect="non-scaling-stroke" />
      {dots &&
        pts
          .filter((_, i) => i % step === 0 || i === pts.length - 1)
          .map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.6" fill={color} />)}
    </svg>
  );
}

/** Deterministic pseudo-trend for list rows until we store per-coin history. */
export function trendShape(seed: string, changePct: number, n = 14): number[] {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const noise = ((h >>> 16) / 65535 - 0.5) * 1.6;
    v += noise + Math.sign(changePct || 1) * 0.45;
    out.push(v);
  }
  return out;
}
