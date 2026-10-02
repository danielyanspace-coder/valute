import type { HistoryItem } from '../../../shared/api';
import { STATUS_LABEL } from '../../../shared/payout';
import { shortUsdt } from '../../../shared/transfers';
import { fmtDateTime, fmtRub0 } from '../lib/format';
import { IconArrowUpRight, IconCard, IconHistory, IconPlus } from './icons';

const who = (p: { username: string | null; firstName: string }) => (p.username ? `@${p.username}` : p.firstName);
const CHECK_STATUS = { active: 'Активен', claimed: 'Активирован', cancelled: 'Отменён' } as const;

interface Props {
  items: HistoryItem[];
  loading: boolean;
  onOpenWithdrawal: (id: number) => void;
  onOpenChecks: () => void;
}

export function HistoryScreen({ items, loading, onOpenWithdrawal, onOpenChecks }: Props) {
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
                  sub={w.destination} amount={`−${fmtRub0(w.amountRub)}`} chip={STATUS_LABEL[w.status]} chipClass={`s-${w.status}`}
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
