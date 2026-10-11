import { useState } from 'react';
import type { GiveawayDto } from '../../../shared/api';
import { shortUsdt } from '../../../shared/transfers';
import { ApiError } from '../lib/api';
import { api } from '../lib/backend';
import { SuccessMark } from '../lib/motion';
import { haptic, hapticNotify } from '../lib/telegram';
import { IconCheck, IconGift } from './icons';
import { Sheet } from './Sheet';

const fmtLeft = (ms: number) => {
  if (ms <= 0) return 'подводим итоги';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(1, m)} мин`;
};
const fmtEnd = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** Home screen card: the current giveaway, or its results for a few days after the draw. */
export function GiveawayBanner({ g, now, onOpen }: { g: GiveawayDto; now: number; onOpen: () => void }) {
  const won = g.results.find((r) => r.you);
  return (
    <button className="card giveaway" onClick={() => { haptic(); onOpen(); }}>
      <span className="giveaway-glow" aria-hidden />
      <span className="giveaway-icon"><IconGift size={22} /></span>
      <span className="giveaway-text">
        <span className="giveaway-kicker">{g.status === 'drawn' ? 'Итоги розыгрыша' : 'Бесплатный розыгрыш'}</span>
        <b>{shortUsdt(g.prizeMicro)} USDT</b>
        <span className="muted">
          {g.status === 'drawn'
            ? won ? `Вы выиграли ${shortUsdt(won.prizeMicro)} USDT` : `${g.results.length} ${plural(g.results.length, 'победитель', 'победителя', 'победителей')}`
            : `${g.winners} ${plural(g.winners, 'победитель', 'победителя', 'победителей')} · ${fmtLeft(g.endsAt - now)}`}
        </span>
      </span>
      {g.status === 'active' && (
        <span className={`giveaway-cta ${g.joined ? 'joined' : ''}`}>{g.joined ? <><IconCheck size={14} /> Вы участвуете</> : 'Участвовать'}</span>
      )}
    </button>
  );
}

export function GiveawaySheet({ g, open, now, onClose, onChange }: { g: GiveawayDto; open: boolean; now: number; onClose: () => void; onChange: (g: GiveawayDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justJoined, setJustJoined] = useState(false);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.joinGiveaway(g.id));
      hapticNotify('success');
      setJustJoined(true);
    } catch (e) {
      hapticNotify('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось. Попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const share = Math.floor(g.prizeMicro / Math.max(1, g.winners));
  return (
    <Sheet open={open} onClose={onClose} title={g.title}>
      <div className="giveaway-sheet">
        {justJoined ? <SuccessMark /> : <span className="modal-icon gift"><IconGift size={26} /></span>}
        <b className="giveaway-prize">{shortUsdt(g.prizeMicro)} USDT</b>
        <span className="muted">
          {g.winners} {plural(g.winners, 'победитель', 'победителя', 'победителей')} по {shortUsdt(share)} USDT
        </span>

        {g.status === 'active' && (
          <div className="giveaway-stats">
            <div><span className="muted">До итогов</span><b>{fmtLeft(g.endsAt - now)}</b></div>
            <div><span className="muted">Участников</span><b>{g.participants.toLocaleString('ru-RU')}</b></div>
          </div>
        )}

        {g.status === 'drawn' && (
          <div className="giveaway-results">
            {g.results.map((r, i) => (
              <div key={i} className={`giveaway-winner ${r.you ? 'you' : ''}`}>
                <span>{r.you ? 'Вы' : r.name}</span>
                <b>+{shortUsdt(r.prizeMicro)} USDT</b>
              </div>
            ))}
          </div>
        )}

        <div className="rules giveaway-rules">
          <div className="rule"><span>Участие бесплатное, покупать ничего не нужно.</span></div>
          <div className="rule"><span>Итоги {fmtEnd(g.endsAt)}. Победители выбираются случайно среди всех участников, приз делится поровну и зачисляется на баланс.</span></div>
          <div className="rule"><span>Статус IX Black и сумма операций на шансы не влияют. Один аккаунт участвует один раз.</span></div>
        </div>

        {error && <div className="field-error center">{error}</div>}
        {g.status === 'active' && (
          <div className="sheet-actions">
            {g.joined ? (
              <button className="btn ghost block" onClick={onClose}><IconCheck size={16} /> Вы участвуете</button>
            ) : (
              <button className="btn primary block" disabled={busy || g.endsAt <= now} onClick={join}>{busy ? 'Секунду…' : 'Участвовать бесплатно'}</button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
