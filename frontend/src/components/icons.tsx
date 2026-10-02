import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = ({ size = 24, ...rest }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...rest,
});

export const IconPlus = (p: P) => (<svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>);
export const IconArrowUpRight = (p: P) => (<svg {...base(p)}><path d="M7 17 17 7M8 7h9v9" /></svg>);
export const IconArrowRight = (p: P) => (<svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>);
export const IconChevronRight = (p: P) => (<svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>);
export const IconSwap = (p: P) => (<svg {...base(p)}><path d="M4 8h15l-4-4M20 16H5l4 4" /></svg>);
export const IconClose = (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const IconEye = (p: P) => (
  <svg {...base(p)}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base(p)}><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
);
export const IconHeadset = (p: P) => (
  <svg {...base(p)}><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="6" rx="1.5" /><rect x="17" y="13" width="4" height="6" rx="1.5" /><path d="M19 19c0 1.5-2 2.5-5 2.5" /></svg>
);
export const IconHelp = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9.5" /><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.9M12 17.2v.01" /></svg>
);
export const IconQr = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="14.5" y="3.5" width="6" height="6" rx="1.5" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1.5" />
    <path d="M14.5 14.5h2.5v2.5M20.5 14.5v.01M14.5 20.5h.01M17.5 20.5h3v-3" />
  </svg>
);
export const IconHome = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M10.6 2.6a2.2 2.2 0 0 1 2.8 0l7.4 6.1c.5.4.7 1 .7 1.6V19a2.5 2.5 0 0 1-2.5 2.5H15v-5.2a1.3 1.3 0 0 0-1.3-1.3h-3.4A1.3 1.3 0 0 0 9 16.3v5.2H5A2.5 2.5 0 0 1 2.5 19v-8.7c0-.6.3-1.2.7-1.6Z" /></svg>
);
export const IconHistory = (p: P) => (
  <svg {...base(p)}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconGrid = (p: P) => (
  <svg {...base(p)}><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></svg>
);
export const IconUser = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6" /></svg>
);
export const IconFlash = (p: P) => (<svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></svg>);
export const IconImage = (p: P) => (
  <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
);

/** Brand mark: two crossed blades, as on the card. */
export const LogoX = ({ size = 36 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <defs>
      <linearGradient id="lx-a" x1="0" y1="0" x2="40" y2="40">
        <stop offset="0" stopColor="#f4f6fb" /><stop offset="1" stopColor="#8d96a8" />
      </linearGradient>
      <linearGradient id="lx-b" x1="40" y1="0" x2="0" y2="40">
        <stop offset="0" stopColor="#dfe6ff" /><stop offset="1" stopColor="#5b6bff" />
      </linearGradient>
    </defs>
    <path d="M4 3c9 4 18 14 32 34-10-5-19-14-32-34Z" fill="url(#lx-a)" />
    <path d="M36 3C27 9 20 16 15 22l3 4C23 18 29 10 36 3Z" fill="url(#lx-b)" />
    <path d="M4 37c4-6 7-9 9-11l2.5 3.5C12 32 8 35 4 37Z" fill="url(#lx-b)" />
  </svg>
);
