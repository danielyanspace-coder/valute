import { useEffect, useState } from 'react';
import type { MeDto, PremiumStatusDto } from '../../../../shared/api';
import { PREMIUM_CASHBACK_BPS, PREMIUM_FINE_PRINT, PREMIUM_NAME, PREMIUM_PERKS, type PremiumPerk } from '../../../../shared/premium';
import { shortUsdt } from '../../../../shared/transfers';
import { ApiError } from '../../lib/api';
import { api } from '../../lib/backend';
import { Confetti } from '../../lib/motion';
import { haptic, hapticNotify, openTelegramChat } from '../../lib/telegram';
import { IconBadge, IconChat, IconChevronRight, IconFlash, IconPercent, LogoX } from '../icons';
import { Sheet } from '../Sheet';

const fmtUntil = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const PERK_ICON: Record<PremiumPerk['key'], React.ReactNode> = {
  priority: <IconFlash size={18} />,
  support: <IconChat size={18} />,
  cashback: <IconPercent size={18} />,
  badge: <IconBadge size={18} />,
};

/** Small "IX Black" mark next to the name. */
export function PremiumChip() {
  return (
    <span className="premium-chip">
      <LogoX size={11} /> {PREMIUM_NAME}
    </span>
  );
}

/** The entry point in the profile: a black metal strip. */
export function PremiumCard({ until, onOpen }: { until: number | null; onOpen: () => void }) {
  return (
    <button className={`premium-card ${until ? 'on' : ''}`} onClick={() => { haptic(); onOpen(); }}>
      <span className="premium-sheen" aria-hidden />
      <span className="premium-card-logo"><LogoX size={22} /></span>
      <span className="premium-card-text">
        <b>{PREMIUM_NAME}</b>
        <span>{until ? `Активен до ${fmtUntil(until)}` : 'Заявки без очереди и кэшбэк 0.2%'}</span>
      </span>
      <IconChevronRight size={16} className="premium-card-arrow" />
    </button>
  );
}

/** The metal card on top of the sheet. */
function BlackCard({ name, until, shine }: { name: string; until: number | null; shine: number }) {
  return (
    <div className="black-card" key={shine}>
      <span className="premium-sheen" aria-hidden />
      <div className="black-card-top">
        <LogoX size={30} />
        <span className="black-card-name">{PREMIUM_NAME}</span>
      </div>
      <div className="black-card-chip" aria-hidden />
      <div className="black-card-bottom">
        <span>{name || 'Crypto IX'}</span>
        <span>{until ? `до ${new Date(until).toLocaleDateString('ru-RU')}` : 'Crypto IX'}</span>
      </div>
    </div>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  me: MeDto | null;
  onBought: () => void;
  onDeposit: () => void;
}

export function PremiumSheet({ open, onClose, me, onBought, onDeposit }: SheetProps) {
  const [status, setStatus] = useState<PremiumStatusDto | null>(null);
  const [plan, setPlan] = useState('month');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lowBalance, setLowBalance] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLowBalance(false);
    api.premium().then(setStatus).catch(() => setStatus(null));
  }, [open]);

  const u = me?.user;
  const name = u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '';
  const until = status?.until ?? me?.premium?.until ?? null;
  const chosen = status?.plans.find((p) => p.id === plan) ?? null;
  const expectedCashback = status ? Math.floor((status.monthTurnoverMicro * PREMIUM_CASHBACK_BPS) / 10_000) : 0;

  const buy = async () => {
    if (!chosen || busy) return;
    setError(null);
    setLowBalance(false);
    if ((me?.availableMicro ?? 0) < chosen.priceMicro) {
      hapticNotify('error');
      setLowBalance(true);
      setError(`Не хватает ${shortUsdt(chosen.priceMicro - (me?.availableMicro ?? 0))} USDT на балансе`);
      return;
    }
    setBusy(true);
    try {
      const s = await api.buyPremium(chosen.id, requestId);
      setStatus(s);
      setRequestId(crypto.randomUUID());
      haptic('heavy');
      setTimeout(() => hapticNotify('success'), 180);
      setCelebrate(Date.now());
      document.querySelector('.sheet')?.scrollTo({ top: 0, behavior: 'smooth' });
      onBought();
    } catch (e) {
      hapticNotify('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось оформить. Попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="" tall>
      <Confetti fire={celebrate} />
      <div className="premium">
        <BlackCard name={name} until={until} shine={celebrate} />

        <div className="premium-title">
          {until ? (
            <>
              <b>{celebrate ? 'Добро пожаловать в IX Black' : `${PREMIUM_NAME} активен`}</b>
              <span className="muted">до {fmtUntil(until)}</span>
            </>
          ) : (
            <>
              <b>{PREMIUM_NAME}</b>
              <span className="muted">Ваши заявки без очереди</span>
            </>
          )}
        </div>

        {until && status && (
          <div className="premium-month">
            <div><span className="muted">Оборот в этом месяце</span><b>{shortUsdt(status.monthTurnoverMicro)} USDT</b></div>
            <div><span className="muted">Кэшбэк 1 числа</span><b className="up">≈ {shortUsdt(expectedCashback)} USDT</b></div>
          </div>
        )}

        <div className="premium-perks">
          {PREMIUM_PERKS.map((p) => (
            <div key={p.key} className="premium-perk">
              <span className="premium-perk-icon">{PERK_ICON[p.key]}</span>
              <span>
                <b>{p.title}</b>
                <span className="muted">{p.text}</span>
              </span>
            </div>
          ))}
        </div>

        {until && me?.supportUsername && (
          <button className="btn ghost block" onClick={() => { haptic(); openTelegramChat(me.supportUsername, `${PREMIUM_NAME} · ID ${me.user.id}: `); }}>
            <IconChat size={16} /> Приоритетная поддержка
          </button>
        )}

        <div className="premium-plans" role="radiogroup">
          {(status?.plans ?? []).map((p) => (
            <button key={p.id} role="radio" aria-checked={plan === p.id} className={`premium-plan ${plan === p.id ? 'on' : ''}`}
              onClick={() => { haptic(); setPlan(p.id); setError(null); }}>
              {p.note && <span className="premium-plan-note">{p.note}</span>}
              <span className="muted">{p.title}</span>
              <b>{shortUsdt(p.priceMicro)} USDT</b>
              <span className="muted tiny">{shortUsdt(Math.round(p.priceMicro / (p.days / 30)))} USDT в месяц</span>
            </button>
          ))}
        </div>

        {error && <div className="field-error center" key={error + busy}>{error}</div>}
        <div className="sheet-actions">
          {lowBalance ? (
            <button className="btn primary block" onClick={() => { onClose(); onDeposit(); }}>Пополнить баланс</button>
          ) : (
            <button className="btn premium-buy block" disabled={!chosen || busy} onClick={buy}>
              {busy ? 'Оформляем…' : `${until ? 'Продлить' : 'Оформить'} за ${chosen ? shortUsdt(chosen.priceMicro) : '…'} USDT`}
            </button>
          )}
        </div>
        <p className="premium-fine muted">{PREMIUM_FINE_PRINT}</p>
      </div>
    </Sheet>
  );
}
