import type { WithdrawalDto } from '../../../shared/api';
import { STATUS_LABEL } from '../../../shared/payout';
import { fmtDateTime, fmtRub0 } from '../lib/format';
import { IconCard, IconHistory } from './icons';

export function HistoryScreen({ items, loading, onOpen }: { items: WithdrawalDto[]; loading: boolean; onOpen: (id: number) => void }) {
  return (
    <section className="history">
      <h2 className="screen-title">История</h2>
      {loading && items.length === 0 && [0, 1, 2].map((i) => <div key={i} className="card skeleton-row" />)}
      {!loading && items.length === 0 && (
        <div className="empty-state card">
          <IconHistory size={28} />
          <b>Операций пока нет</b>
          <span className="muted">Здесь появятся пополнения и выводы</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="card history-list">
          {items.map((w) => (
            <button key={w.id} className="history-row" onClick={() => onOpen(w.id)}>
              <span className="history-icon"><IconCard size={18} /></span>
              <span className="history-main">
                <b>{w.method === 'sbp' ? 'Вывод по СБП' : 'Вывод на карту'}</b>
                <span className="muted">{w.destination}</span>
              </span>
              <span className="history-side">
                <b>−{fmtRub0(w.amountRub)}</b>
                <span className={`status-chip s-${w.status}`}>{STATUS_LABEL[w.status]}</span>
                <span className="muted tiny">{fmtDateTime(w.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
