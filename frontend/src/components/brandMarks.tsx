// Payment brand marks. Shapes are the official ones: SBP from sbp.nspk.ru, Mir from Wikimedia Commons.

export function SbpMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={(size * 283) / 326} height={size} viewBox="0 0 283 326" aria-label="СБП">
      <path d="M82.07 157.97 39.5 182.51 0 250.88l161.13-92.91H82.07Z" fill="#874691" />
      <path d="M203.7 92.91 161.13 117.45l-39.5 68.37 161.07-92.91h-79Z" fill="#DA1844" />
      <path d="M161.13 68.38 121.63 0v326l39.5-68.38V68.38Z" fill="#F9B229" />
      <path d="m121.63 0 39.5 68.38 42.57 24.53h79L121.63 0Z" fill="#F07F1A" />
      <path d="M121.63 140.18V326l39.5-68.38v-49.13l-39.5-68.31Z" fill="#72B22C" />
      <path d="m203.7 233.09-42.57 24.53L121.63 326l161.07-92.91h-79Z" fill="#00743E" />
      <path d="M0 70.06v185.82l39.5-68.37v-49.08L0 70.06Z" fill="#5F5A94" />
      <path d="M121.63 140.18v.06L0 70.06l39.5 68.37 164.2 94.66h79L121.63 140.18Z" fill="#0D90CD" />
    </svg>
  );
}

export function MirMark({ width = 34 }: { width?: number }) {
  return (
    <svg width={width} height={(width * 120) / 400} viewBox="0 0 400 120" aria-label="МИР">
      <defs>
        <linearGradient id="mir-g" x1="370" x2="290" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1F5CD7" />
          <stop stopColor="#02AEFF" offset="1" />
        </linearGradient>
      </defs>
      <path
        d="m31 13h33c3 0 12-1 16 13 3 9 7 23 13 44h2c6-22 11-37 13-44 4-14 14-13 18-13h31v96h-32v-57h-2l-17 57h-24l-17-57h-3v57h-31m139-96h32v57h3l21-47c4-9 13-10 13-10h30v96h-32v-57h-2l-21 47c-4 9-14 10-14 10h-30m142-29v29h-30v-50h98c-4 12-18 21-34 21"
        fill="#0f754e"
      />
      <path d="m382 53c4-18-8-40-34-40h-68c2 21 20 40 39 40" fill="url(#mir-g)" />
    </svg>
  );
}

/** SBP and Mir tiles overlapping, for "withdraw to a bank card". */
export function SbpMirMark() {
  return (
    <span className="duo-mark" aria-label="СБП и МИР">
      <span className="duo-tile sbp"><SbpMark size={22} /></span>
      <span className="duo-tile mir"><MirMark width={26} /></span>
    </span>
  );
}
