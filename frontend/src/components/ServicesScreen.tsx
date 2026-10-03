import { useState, type ReactNode } from 'react';
import gibddLogo from '../assets/services/gibdd.png';
import steamLogo from '../assets/services/steam.png';
import parkingLogo from '../assets/services/parking.png';
import type { ServiceKind } from '../../../shared/services';
import { haptic } from '../lib/telegram';
import { IconArrowUpRight, IconChevronRight, IconPlus } from './icons';
import { Sheet } from './Sheet';

interface Props {
  onDeposit: () => void;
  onWithdraw: () => void;
  onService: (kind: ServiceKind) => void;
}

interface Service {
  id: string;
  /** Opens the working flow; services without it show a "coming soon" sheet. */
  kind?: ServiceKind;
  title: string;
  subtitle: string;
  logo: ReactNode;
  discount?: number;
  about: string;
}

const SERVICES: Service[] = [
  {
    id: 'fines',
    kind: 'fine',
    title: 'Оплата штрафов ГИБДД',
    subtitle: 'Найдём штраф по УИН и оплатим за вас',
    logo: <img src={gibddLogo} alt="" />,
    discount: 10,
    about: 'Проверка и оплата штрафов Госавтоинспекции с баланса USDT на 10% дешевле суммы штрафа.',
  },
  {
    id: 'parking',
    kind: 'parking',
    title: 'Парковки России',
    subtitle: 'Пополнение парковочного счёта',
    logo: <img src={parkingLogo} alt="" />,
    discount: 10,
    about: '',
  },
  {
    id: 'steam',
    kind: 'steam',
    title: 'Пополнение Steam',
    subtitle: 'Деньги на аккаунт за пару минут',
    logo: <img src={steamLogo} alt="" />,
    discount: 10,
    about: 'Пополнение кошелька Steam по логину с баланса USDT на 10% выгоднее.',
  },
  {
    id: 'tours',
    title: 'Купить тур',
    subtitle: 'Туры по всему миру с оплатой в USDT',
    logo: <TourIcon />,
    about: 'Подбор и покупка туров с оплатой прямо из кошелька.',
  },
];

export function ServicesScreen({ onDeposit, onWithdraw, onService }: Props) {
  const [open, setOpen] = useState<Service | null>(null);
  return (
    <section className="services">
      <h2 className="screen-title">Сервисы</h2>

      <div className="svc-wallet">
        <button className="card svc-tile" onClick={() => { haptic(); onDeposit(); }}>
          <span className="action-icon"><IconPlus size={18} /></span>
          <b>Пополнить</b>
          <span className="muted">USDT · TRC-20</span>
        </button>
        <button className="card svc-tile" onClick={() => { haptic(); onWithdraw(); }}>
          <span className="action-icon"><IconArrowUpRight size={17} /></span>
          <b>Вывести</b>
          <span className="muted">На карту или по СБП</span>
        </button>
      </div>

      {SERVICES.map((s) => (
        <button key={s.id} className="card svc-card" onClick={() => { haptic(); if (s.kind) onService(s.kind); else setOpen(s); }}>
          <ServiceLogo id={s.id} logo={s.logo} discount={s.discount} />
          <span className="svc-text">
            <b>{s.title}</b>
            <span className="muted">{s.subtitle}</span>
          </span>
          <IconChevronRight size={16} className="muted" />
        </button>
      ))}

      <Sheet open={!!open} onClose={() => setOpen(null)} title="">
        {open && (
          <div className="svc-detail">
            <ServiceLogo id={open.id} logo={open.logo} discount={open.discount} big />
            <b>{open.title}</b>
            <p className="muted">{open.about}</p>
            <span className="pill">Скоро</span>
            <button className="btn primary block" onClick={() => setOpen(null)}>Понятно</button>
          </div>
        )}
      </Sheet>
    </section>
  );
}

/** Logo tile with an optional "−10%" tag pinned to the corner like a price sticker. */
function ServiceLogo({ id, logo, discount, big }: { id: string; logo: ReactNode; discount?: number; big?: boolean }) {
  return (
    <span className={`svc-logo svc-logo-${id} ${big ? 'big' : ''}`}>
      <span className="svc-logo-inner">{logo}</span>
      {discount && (
        <span className="svc-discount" aria-label={`Скидка ${discount}%`}>
          −{discount}%
        </span>
      )}
    </span>
  );
}

function TourIcon() {
  return (
    <svg viewBox="0 0 48 48" width="100%" height="100%" aria-hidden>
      <defs>
        <linearGradient id="tour-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4fc3ff" />
          <stop offset="1" stopColor="#ffb86b" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" fill="url(#tour-sky)" />
      <circle cx="33" cy="30" r="7" fill="#ffe08a" />
      <path d="M0 37c8-4 16-4 24 0s16 4 24 0v11H0Z" fill="#1a9fd8" />
      <path d="M0 41c8-3 16-3 24 0s16 3 24 0v7H0Z" fill="#0d7fb8" />
      <path d="M8 18 30 10l3 1.5-9 5.5 7 1.5 3-2 2 .8-3.5 4.2-1.5 2-2-.8.8-3.2-7-2.5-5 6.5-2.6-.6 2.6-6.8-4.4-.8Z" fill="#fff" />
    </svg>
  );
}
