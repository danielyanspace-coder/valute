import type { HistoryItem } from '../../../shared/api';
import { userStatusLabel } from '../../../shared/deals';
import { ORDER_STATUS_LABEL, SERVICE_TITLE } from '../../../shared/services';
import { SERVICE_LOGO } from './services/ServiceFlows';
import { shortUsdt } from '../../../shared/transfers';
import { fmtDateTime, fmtRub0 } from '../lib/format';
import { IconAlert, IconArrowUpRight, IconCard, IconHistory, IconPlus } from './icons';
import { CoinIcon } from './CoinIcon';
import { DEPOSIT_STATUS_LABEL } from './deposit/DepositDetailSheet';
import type { DepositDto } from '../../../shared/api';
import { USDT_PAYOUT_STATUS_LABEL } from '../../../shared/usdtPayout';

const who = (p: { username: string | null; firstName: string }) => (p.username ? `@${p.username}` : p.firstName);
const CHECK_STATUS = { active: 'Активен', claimed: 'Активирован', cancelled: 'Отменён' } as const;

interface Props {
  items: HistoryItem[];
  loading: boolean;
  onOpenWithdrawal: (id: number) => void;
  onOpenChecks: () => void;
  onOpenOrder: (id: number) => void;
  onOpenDeposit: (d: DepositDto) => void;
  onOpenUsdtPayout: (id: number) => void;
}

export function HistoryScreen({ items, loading, onOpenWithdrawal, onOpenChecks, onOpenOrder, onOpenDeposit, onOpenUsdtPayout }: Props) {
  return (
    <section className="history">
      <h2 className="screen-title">История</h2>
      {loading && items.length === 0 && [0, 1, 2].map((i) => <div key={i} className="card skeleton-row" />)}
      {!loading && items.length === 0 && (
        <div className="empty-state card">
          <IconHistory size={28} />
          <b>Операций пока нет</b>
          <span className="muted">Здесь появятся пополнения, переводы и выводы</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="card history-list">
          {items.map((h) => {
            if (h.type === 'withdrawal') {
              const w = h.withdrawal;
              return (
                <Row key={`w${w.id}`} icon={<IconCard size={18} />} title={w.method === 'sbp' ? 'Вывод по СБП' : 'Вывод на карту'}
                  sub={w.destination} amount={`−${fmtRub0(w.finalRub ?? w.amountRub)}`} chip={userStatusLabel({ status: w.status, enteredAt: w.enteredAt }, w.serverNow)}
                  chipClass={`s-${w.status === 'completed' || w.status === 'user_confirmed' ? 'completed' : w.status === 'cancelled' ? 'rejected' : w.actions.length ? 'sent' : 'pending'}`}
                  at={w.createdAt} onClick={() => onOpenWithdrawal(w.id)} />
              );
            }
            if (h.type === 'transfer') {
              const t = h.transfer;
              const incoming = t.direction === 'in';
              return (
                <Row key={`t${t.id}`} icon={incoming ? <IconPlus size={18} /> : <IconArrowUpRight size={17} />} iconClass={incoming ? 'in' : ''}
                  title={incoming ? (t.kind === 'check' ? 'Получен чек' : 'Получен перевод') : 'Перевод'}
                  sub={`${incoming ? 'от' : 'для'} ${who(t.counterparty)}${t.comment ? ` · ${t.comment}` : ''}`}
                  amount={`${incoming ? '+' : '−'}${shortUsdt(t.amountMicro)} USDT`} amountClass={incoming ? 'up' : ''} at={t.createdAt} />
              );
            }
            if (h.type === 'order') {
              const o = h.order;
              return (
                <Row key={`o${o.id}`} icon={<img src={SERVICE_LOGO[o.kind]} alt="" />} iconClass="svc" title={SERVICE_TITLE[o.kind]}
                  sub={o.target} amount={`−${shortUsdt(o.amountMicro)} USDT`} chip={ORDER_STATUS_LABEL[o.status]} chipClass={`o-${o.status}`}
                  at={o.createdAt} onClick={() => onOpenOrder(o.id)} />
              );
            }
            if (h.type === 'deposit') {
              const d = h.deposit;
              return (
                <Row key={`d${d.id}`} icon={<CoinIcon symbol="USDT" size={36} />} iconClass="dep" title="Пополнение"
                  sub="USDT · TRON (TRC-20)" amount={`+${shortUsdt(d.amountMicro)} USDT`} amountClass={d.status === 'credited' ? 'up' : ''}
                  chip={d.status === 'credited' ? undefined : DEPOSIT_STATUS_LABEL[d.status]} chipClass={`dep-${d.status}`}
                  at={d.createdAt} onClick={() => onOpenDeposit(d)} />
              );
            }
            if (h.type === 'usdt_payout') {
              const p = h.usdtPayout;
              return (
                <Row key={`u${p.id}`} icon={<CoinIcon symbol="USDT" size={36} />} iconClass="dep" title="Вывод USDT"
                  sub={`на ${p.address.slice(0, 6)}…${p.address.slice(-4)} · TRC-20`}
                  amount={`−${shortUsdt(p.status === 'rejected' ? p.amountMicro : p.totalMicro)} USDT`}
                  chip={USDT_PAYOUT_STATUS_LABEL[p.status]} chipClass={`s-${p.status === 'sent' ? 'completed' : p.status === 'rejected' ? 'rejected' : 'pending'}`}
                  at={p.createdAt} onClick={() => onOpenUsdtPayout(p.id)} />
              );
            }
            if (h.type === 'deduction') {
              const d = h.deduction;
              return (
                <Row key={`x${d.id}`} icon={<IconAlert size={17} />} title="Удержание" sub={d.reason}
                  amount={`−${shortUsdt(d.amountMicro)} USDT`} at={d.createdAt} />
              );
            }
            const c = h.check;
            return (
              <Row key={`c${c.id}`} icon={<span className="check-mini sm">ЧЕК</span>} title="Чек"
                sub={c.status === 'claimed' && c.claimedBy ? `активировал ${who(c.claimedBy)}` : c.comment ?? 'ссылка для получения'}
                amount={`−${shortUsdt(c.amountMicro)} USDT`} chip={CHECK_STATUS[c.status]} chipClass={`c-${c.status}`} at={c.createdAt} onClick={onOpenChecks} />
            );
          })}
        </div>
      )}
    </section>
  );
}

function Row(p: {
  icon: React.ReactNode; iconClass?: string; title: string; sub: string; amount: string; amountClass?: string;
  chip?: string; chipClass?: string; at: number; onClick?: () => void;
}) {
  return (
    <button className="history-row" onClick={p.onClick} disabled={!p.onClick}>
      <span className={`history-icon ${p.iconClass ?? ''}`}>{p.icon}</span>
      <span className="history-main">
        <b>{p.title}</b>
        <span className="muted">{p.sub}</span>
      </span>
      <span className="history-side">
        <b className={p.amountClass}>{p.amount}</b>
        {p.chip && <span className={`status-chip ${p.chipClass}`}>{p.chip}</span>}
        <span className="muted tiny">{fmtDateTime(p.at)}</span>
      </span>
    </button>
  );
}
