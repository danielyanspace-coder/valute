import { useEffect, useRef, useState } from 'react';
import type { GiveawayDto } from '../../../shared/api';
import { shortUsdt } from '../../../shared/transfers';
import { reducedMotion } from '../lib/motion';
import { haptic } from '../lib/telegram';
import { IconArrowRight, IconGift, LogoX } from './icons';

const AUTO_MS = 5000;

const fmtLeft = (ms: number) => {
  if (ms <= 0) return 'подводим итоги';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(1, m)} мин`;
};
const winnersWord = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'победитель' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'победителя' : 'победителей';
};

interface Props {
  giveaway: GiveawayDto | null;
  premiumUntil: number | null;
  now: number;
  onGiveaway: () => void;
  onPremium: () => void;
}

/** Thin self-scrolling strip under the rate: the giveaway and the IX Black offer. Swipeable, pauses on touch. */
export function PromoStrip({ giveaway, premiumUntil, now, onGiveaway, onPremium }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const slides = (giveaway ? ['giveaway', 'premium'] : ['premium']) as ('giveaway' | 'premium')[];
  const count = slides.length;

  // The giveaway arrives after the first render: start again from the first slide.
  useEffect(() => {
    ref.current?.scrollTo({ left: 0 });
    setIndex(0);
  }, [count]);

  // Auto-advance; a touch pauses it for one cycle.
  useEffect(() => {
    if (count < 2 || paused || reducedMotion()) return;
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const next = (index + 1) % count;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, AUTO_MS);
    return () => clearTimeout(t);
  }, [index, count, paused]);

  useEffect(() => {
    if (!paused) return;
    const t = setTimeout(() => setPaused(false), AUTO_MS * 2);
    return () => clearTimeout(t);
  }, [paused]);

  const onScroll = () => {
    const el = ref.current;
    if (el) setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
  };

  const g = giveaway;
  const won = g?.results.find((r) => r.you);

  return (
    <div className="strip-wrap">
      <div className="strip" ref={ref} onScroll={onScroll} onTouchStart={() => setPaused(true)} onPointerDown={() => setPaused(true)}>
        {slides.map((s) =>
          s === 'giveaway' && g ? (
            <button key={s} className="strip-slide strip-gw" onClick={() => { haptic(); onGiveaway(); }}>
              <span className="strip-wave" aria-hidden />
              <span className="strip-gift"><IconGift size={17} /></span>
              <span className="strip-text">
                <b className="strip-title">{shortUsdt(g.prizeMicro)} <span className="strip-usdt">USDT</span></b>
                <span className="strip-sub">
                  {g.status === 'drawn'
                    ? won ? `Вы выиграли ${shortUsdt(won.prizeMicro)} USDT` : `Итоги · ${g.results.length} ${winnersWord(g.results.length)}`
                    : `Розыгрыш · ${fmtLeft(g.endsAt - now)}`}
                </span>
              </span>
              <span className={`strip-cta ${g.joined ? 'done' : ''}`}>
                {g.status !== 'active' ? 'Итоги' : g.joined ? 'Вы участвуете' : <>Участвовать <IconArrowRight size={13} /></>}
              </span>
            </button>
          ) : (
            <button key={s} className="strip-slide strip-ix" onClick={() => { haptic(); onPremium(); }}>
              <span className="premium-sheen" aria-hidden />
              <span className="strip-ix-logo"><LogoX size={18} /></span>
              <span className="strip-text">
                <b className="strip-title">IX Black</b>
                <span className="strip-sub">{premiumUntil ? `Активен до ${new Date(premiumUntil).toLocaleDateString('ru-RU')}` : `Приоритет · кэшбэк 0.2%`}</span>
              </span>
              <span className="strip-cta light">
                {premiumUntil ? 'Открыть' : <>Подключить <IconArrowRight size={13} /></>}
              </span>
            </button>
          ),
        )}
      </div>
      {count > 1 && (
        <div className="strip-dots" aria-hidden>
          {slides.map((s, i) => <i key={s} className={i === index ? 'on' : ''} />)}
        </div>
      )}
    </div>
  );
}
