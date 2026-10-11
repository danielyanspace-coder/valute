import { useCallback, useState } from 'react';
import type { AdminGiveawayDto, AdminPremiumDto } from '../../../shared/api';
import { shortUsdt } from '../../../shared/transfers';
import type { AdminApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { ConfirmDialog, type ConfirmRequest } from './ui';

const STATUS = { active: 'Идёт', drawn: 'Проведён', cancelled: 'Отменён' } as const;
const DAY = 86_400_000;
/** datetime-local value for a timestamp in the browser's time zone. */
const toLocal = (t: number) => {
  const d = new Date(t - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** Free giveaways: create one, watch participants, draw winners after the end. Also the IX Black list. */
export function GiveawaysPanel({ api, onOpenUser }: { api: AdminApi; onOpenUser: (id: number) => void }) {
  const [items, setItems] = useState<AdminGiveawayDto[]>([]);
  const [premium, setPremium] = useState<AdminPremiumDto | null>(null);
  const [title, setTitle] = useState('');
  const [prize, setPrize] = useState('');
  const [winners, setWinners] = useState('10');
  const [endsAt, setEndsAt] = useState(() => toLocal(Date.now() + 7 * DAY));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const load = useCallback(() => {
    api.giveaways().then((r) => setItems(r.items), () => {});
    api.premium().then(setPremium, () => {});
  }, [api]);
  usePolling(load, 5000);

  const active = items.find((g) => g.status === 'active');
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.giveawayCreate({ title, prizeUsdt: Number(prize.replace(',', '.')), winners: Number(winners), endsAt: new Date(endsAt).getTime() });
      setTitle('');
      setPrize('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askDraw = (g: AdminGiveawayDto) =>
    setConfirm({
      title: 'Провести розыгрыш?',
      text: `${g.participants} участников, ${g.winners} победителей. Каждому начислится ${shortUsdt(Math.floor(g.prizeMicro / Math.max(1, Math.min(g.winners, g.participants))))} USDT из призового фонда ${shortUsdt(g.prizeMicro)} USDT. Отменить начисление нельзя.`,
      confirmLabel: 'Провести',
      tone: 'success',
      run: async () => {
        await api.giveawayDraw(g.id);
        load();
      },
    });
  const askCancel = (g: AdminGiveawayDto) =>
    setConfirm({
      title: 'Отменить розыгрыш?',
      text: 'Розыгрыш исчезнет из кошелька, призы не начисляются.',
      confirmLabel: 'Отменить розыгрыш',
      tone: 'danger',
      run: async () => {
        await api.giveawayCancel(g.id);
        load();
      },
    });

  return (
    <div className="ab-page gw">
      {!active && (
        <div className="adm-card gw-form">
          <div className="adm-card-title">Новый розыгрыш</div>
          <label className="adm-field"><span>Название</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Осенний розыгрыш" maxLength={80} /></label>
          <div className="gw-row">
            <label className="adm-field"><span>Призовой фонд, USDT</span><input value={prize} onChange={(e) => setPrize(e.target.value)} inputMode="decimal" placeholder="1000" /></label>
            <label className="adm-field"><span>Победителей</span><input value={winners} onChange={(e) => setWinners(e.target.value)} inputMode="numeric" /></label>
          </div>
          <label className="adm-field"><span>Итоги</span><input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label>
          <p className="gw-hint">Участие бесплатное для всех. Фонд начисляется победителям из ваших средств, указывайте реальную сумму.</p>
          {error && <div className="adm-error">{error}</div>}
          <button className="adm-btn primary big" disabled={busy || !title.trim() || !prize} onClick={create}>{busy ? 'Создаём…' : 'Запустить розыгрыш'}</button>
        </div>
      )}

      <div className="gw-list">
        {items.map((g) => (
          <div key={g.id} className={`adm-card gw-item ${g.status}`}>
            <div className="adm-card-head">
              <b>{g.title}</b>
              <span className={`gw-status ${g.status}`}>{STATUS[g.status]}</span>
            </div>
            <div className="gw-nums">
              <div><span>Фонд</span><b>{shortUsdt(g.prizeMicro)} USDT</b></div>
              <div><span>Победителей</span><b>{g.winners}</b></div>
              <div><span>Участников</span><b>{g.participants}</b></div>
              <div><span>Итоги</span><b>{fmtDateTime(g.endsAt)}</b></div>
            </div>
            {g.status === 'active' && (
              <div className="gw-actions">
                <button className="adm-btn danger-ghost" onClick={() => askCancel(g)}>Отменить</button>
                <button className="adm-btn success big" disabled={g.endsAt > Date.now() || !g.participants} onClick={() => askDraw(g)}>
                  {g.endsAt > Date.now() ? 'Провести после окончания' : 'Провести розыгрыш'}
                </button>
              </div>
            )}
            {g.results.length > 0 && (
              <div className="gw-winners">
                {g.results.map((r) => (
                  <button key={r.userId} className="gw-winner" onClick={() => onOpenUser(r.userId)}>
                    <span>{r.name}{r.username ? ` · @${r.username}` : ''}</span>
                    <b>+{shortUsdt(r.prizeMicro)} USDT</b>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {!items.length && <div className="adm-card gw-empty">Розыгрышей ещё не было</div>}
      </div>

      {premium && (
        <div className="adm-card gw-premium">
          <div className="adm-card-head">
            <div className="adm-card-title">IX Black</div>
            <span className="gw-premium-sum">выручка {shortUsdt(premium.revenueMicro)} USDT · кэшбэк {shortUsdt(premium.cashbackMicro)} USDT</span>
          </div>
          {premium.active.length ? (
            premium.active.map((p) => (
              <button key={p.userId} className="gw-winner" onClick={() => onOpenUser(p.userId)}>
                <span><i className="ix-badge">IX Black</i> {p.name}{p.username ? ` · @${p.username}` : ''}</span>
                <span className="gw-until">до {fmtDateTime(p.until)}</span>
              </button>
            ))
          ) : (
            <div className="gw-empty">Активных статусов пока нет</div>
          )}
        </div>
      )}
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
