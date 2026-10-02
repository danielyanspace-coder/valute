import type { ReactNode } from 'react';

const COINS: Record<string, { bg: string; glyph: ReactNode }> = {
  BTC: {
    bg: 'linear-gradient(135deg,#ffb04a,#f7931a)',
    glyph: <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="800" fill="#fff" transform="rotate(12 12 12)">₿</text>,
  },
  ETH: {
    bg: 'linear-gradient(135deg,#8a9bff,#4a5ff0)',
    glyph: (
      <g fill="#fff">
        <path d="M12 3 6.5 12.2 12 15.4l5.5-3.2Z" opacity=".95" />
        <path d="m12 16.5-5.5-3.2L12 21l5.5-7.7Z" opacity=".75" />
      </g>
    ),
  },
  USDT: {
    bg: 'linear-gradient(135deg,#3fc6a0,#1a9f7a)',
    glyph: <path d="M6 6.5h12v2.6h-4.6v2c2.6.2 4.6.8 4.6 1.5s-2 1.3-4.6 1.5V19h-2.8v-4.9C8 13.9 6 13.3 6 12.6s2-1.3 4.6-1.5v-2H6Zm4.6 5.5c-1.8.1-3.1.4-3.1.6s1.9.7 4.5.7 4.5-.4 4.5-.7-1.3-.5-3.1-.6v1.2h-2.8Z" fill="#fff" />,
  },
  SOL: {
    bg: '#0b0b10',
    glyph: (
      <g>
        <defs>
          <linearGradient id="sol-g" x1="5" y1="18" x2="19" y2="6">
            <stop offset="0" stopColor="#9945ff" /><stop offset="1" stopColor="#14f195" />
          </linearGradient>
        </defs>
        <path d="M7.6 6.5h11l-2.2 2.3h-11ZM5.4 10.85h11l2.2 2.3h-11ZM7.6 15.2h11l-2.2 2.3h-11Z" fill="url(#sol-g)" />
      </g>
    ),
  },
};

export function CoinIcon({ symbol, size = 44 }: { symbol: string; size?: number }) {
  const coin = COINS[symbol];
  return (
    <div className="coin-icon" style={{ width: size, height: size, background: coin?.bg ?? '#2a2f3a' }}>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24">
        {coin?.glyph ?? <text x="12" y="16" textAnchor="middle" fontSize="10" fill="#fff">{symbol}</text>}
      </svg>
    </div>
  );
}
