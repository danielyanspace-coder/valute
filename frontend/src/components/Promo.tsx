import { IconArrowRight, LogoX } from './icons';

export function Promo({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="card promo" onClick={onOpen}>
      <div className="promo-mountains" aria-hidden />
      <div className="promo-logo"><LogoX size={24} /></div>
      <div className="promo-text">
        <b>Быстрые переводы<br />по всему миру</b>
        <span>Удобно. Безопасно. В любой точке планеты.</span>
      </div>
      <span className="promo-arrow"><IconArrowRight size={16} /></span>
    </button>
  );
}
