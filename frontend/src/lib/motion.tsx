// Small motion kit: a few moments get a short animation and a haptic, nothing loops or blinks.
// Everything respects "reduce motion" in the OS settings.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CoinIcon } from '../components/CoinIcon';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Rolls a number from its previous value to the new one (balance after a deposit, a purchase). */
export function useCountUp(value: number, ms = 650): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || reducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

/** Success circle: the check is drawn, a soft ring goes out once. */
export function SuccessMark({ size = 56 }: { size?: number }) {
  return (
    <span className="success-mark" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 56 56" width={size} height={size}>
        <circle className="sm-ring" cx="28" cy="28" r="26" />
        <path className="sm-check" d="M17 29 25 37 40 20" />
      </svg>
    </span>
  );
}

/** A USDT coin that drops in and settles, for credited deposits. */
export function CoinDrop() {
  return (
    <span className="coin-drop" aria-hidden>
      <CoinIcon symbol="USDT" size={52} />
    </span>
  );
}

/**
 * Short confetti burst on a canvas, used for exactly two moments: buying IX Black and
 * winning a giveaway. Muted brand colors, 1.4 s, then the canvas removes itself.
 */
export function Confetti({ fire }: { fire: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!fire || reducedMotion()) return;
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#ffffff', '#b8c0ff', '#7f8cff', '#c9ccd3', '#26a17b'];
    const parts = Array.from({ length: 90 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 80,
      y: innerHeight * 0.38,
      vx: (Math.random() - 0.5) * 9,
      vy: -6 - Math.random() * 7,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 5 + Math.random() * 5,
      h: 3 + Math.random() * 4,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const age = (t - t0) / 1400;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age * age);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (age < 1) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fire]);
  // Portal to <body>: inside a sheet the animated transform would trap position: fixed.
  return createPortal(<canvas ref={ref} className="confetti" aria-hidden />, document.body);
}
