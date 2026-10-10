import { useCallback, useEffect, useState } from 'react';
import type { AdminAuditItem, AdminWithdrawalDto } from '../../../shared/api';
import {
  ADMIN_ACTION_LABEL,
  ADMIN_STATUS_LABEL,
  RESOLUTION_LABEL,
  REMINDER_COUNT,
  adminCan,
  type AdminDealAction,
} from '../../../shared/deals';
import { formatCard, formatRuPhone } from '../../../shared/payout';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtCountdown, fmtDateTime, fmtMicroExact, fmtRub, fmtRub0, fmtTime } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { INSTANT, confirmFor, runInstant } from './dealActions';
import { ObligationForm } from './ObligationsPanel';
import { ACTOR, Card, ConfirmDialog, ContactDialog, PayoutLogo, Row, UserCard, useNow, type ConfirmRequest } from './ui';

/** Slide-over on desktop, full screen on a phone. */
export function DealDrawer(props: {
  api: AdminApi;
  id: number;
  onClose: () => void;
  onChanged: () => void;
  onOpenUser: (id: number) => void;
  onOpenDeal: (id: number) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('ab-noscroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('ab-noscroll');
    };
  }, [props]);
  return (
    <div className="ab-drawer-back" onClick={props.onClose}>
      <aside className="ab-drawer" onClick={(e) => e.stopPropagation()}>
        <DealDetail key={props.id} {...props} />
      </aside>
    </div>
  );
}

const ORDER: AdminDealAction[] = ['take', 'entered', 'requisite_off', 'close', 'confirm', 'accept_correction', 'accept_original', 'reopen', 'cancel'];
const TONE: Record<AdminDealAction, string> = {
  take: 'primary',
  entered: 'warn',
  requisite_off: 'warn',
  close: 'success',
  confirm: 'success',
  accept_correction: 'primary',
  accept_original: 'success',
  reopen: 'warn',
  cancel: 'danger-ghost',
};

export function DealDetail({ api, id, onClose, onChanged, onOpenUser, onOpenDeal }: {
  api: AdminApi;
  id: number;
  onClose: () => void;
  onChanged: () => void;
  onOpenUser: (id: number) => void;
  onOpenDeal: (id: number) => void;
}) {
  const [d, setD] = useState<AdminWithdrawalDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [contact, setContact] = useState(false);
  const [note, setNote] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [newObligation, setNewObligation] = useState(false);

  const load = useCallback(() => {
    api.deal(id).then(setD, (e) => setError((e as Error).message));
  }, [api, id]);
  usePolling(load, 3000);
  const refresh = () => {
    load();
    onChanged();
  };
  const now = useNow(d ? d.serverNow - Date.now() : 0);

  const act = async (action: AdminDealAction) => {
    if (!d) return;
    setError(null);
    try {
      if (INSTANT.includes(action)) {
        await runInstant(api, d, action);
        refresh();
      } else {
        setConfirm(await confirmFor(api, d, action, refresh));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!d) {
    return (
      <div className="ab-detail">
        <div className="ab-detail-head"><button className="ab-x" onClick={onClose}>✕</button></div>
        <div className="adm-empty">{error ?? 'Загружаем…'}</div>
      </div>
    );
  }

  const actions = ORDER.filter((a) => adminCan(d.status, a) && !(a === 'requisite_off' && d.requisiteOffAt));
  const u = d.userDetails;
  const platformLeft = d.platformDeadline ? d.platformDeadline - now : null;

  return (
    <div className="ab-detail">
      <div className={`ab-detail-head s-${d.section ?? d.status}`}>
        <div>
          <div className="ab-detail-title">
            <b>Заявка №{d.id}</b>
            <span className={`ab-chip s-${d.section ?? d.status}`}>{ADMIN_STATUS_LABEL[d.status]}</span>
          </div>
          <div className="ab-detail-amount">{fmtRub0(d.amountRub)}</div>
          <div className="adm-muted">
            {fmtMicroExact(d.amountMicro)} по курсу {fmtRub(d.rate)} · создана {fmtDateTime(d.createdAt)} ({fmtAgo(d.createdAt, now)})
          </div>
        </div>
        <button className="ab-x" onClick={onClose} aria-label="Закрыть">✕</button>
      </div>

      {/* State banners */}
      {d.enteredAt && !d.requisiteOffAt && !d.finishedAt && (
        <div className="adm-banner info">
          <b>Отключите приём сделок для реквизита {d.requisite}.</b>
          <span>После отключения нажмите «ОТКЛЮЧИЛ».</span>
        </div>
      )}
      {d.status === 'entered' && d.inactiveAt && (
        <div className="adm-banner">
          Ждём ответа пользователя: отправлено {d.remindersSent} из {REMINDER_COUNT} уведомлений
          {d.nextReminderAt ? `, следующее через ${fmtCountdown(d.nextReminderAt - now)}` : ''}. Станет неактивным через {fmtCountdown(d.inactiveAt - now)}.
        </div>
      )}
      {d.status === 'entered' && d.userActiveAt && (
        <div className="adm-banner ok">Пользователь на связи: нажал «Оплата ещё не поступила» {fmtDateTime(d.userActiveAt)}. На сделку это не влияет.</div>
      )}
      {platformLeft !== null && (d.status === 'entered' || d.status === 'user_confirmed') && (
        <div className={`adm-banner ${platformLeft < 3 * 60_000 ? 'danger' : ''}`}>
          {platformLeft > 0 ? `Таймер площадки: сделка слетит через ${fmtCountdown(platformLeft)}` : 'Таймер площадки (15 минут) истёк'}
        </div>
      )}
      {d.status === 'user_confirmed' && <div className="adm-banner ok">Пользователь подтвердил получение {d.userConfirmedAt ? fmtDateTime(d.userConfirmedAt) : ''}. USDT списаны. Подтвердите сделку на площадке и закройте её.</div>}
      {d.status === 'not_received' && <div className="adm-banner danger">Пользователь сообщил, что оплата не поступила {d.userDecidedAt ? fmtDateTime(d.userDecidedAt) : ''}. USDT заморожены.</div>}
      {d.status === 'inactive' && <div className="adm-banner danger">Пользователь не ответил на {REMINDER_COUNT} уведомлений{d.inactiveSince ? `, неактивен с ${fmtTime(d.inactiveSince)}` : ''}. USDT заморожены.</div>}
      {d.status === 'mismatch' && d.correction && (
        <div className="adm-banner info">
          <b>Пользователь получил {fmtRub0(d.correction.reportedRub)} вместо {fmtRub0(d.amountRub)}</b>
          <span>
            По курсу сделки это {fmtMicroExact(d.correction.correctedMicro)}.
            {d.correction.refundMicro > 0 && ` При принятии корректировки вернётся ${fmtMicroExact(d.correction.refundMicro)}.`}
            {d.correction.extraMicro > 0 && ` Нужно дополнительно ${fmtMicroExact(d.correction.extraMicro)}, на балансе есть ${fmtMicroExact(d.correction.fromAvailableMicro)}.`}
          </span>
        </div>
      )}
      {(d.status === 'completed' || d.status === 'cancelled') && (
        <div className={`adm-banner ${d.status === 'completed' ? 'ok' : ''}`}>
          {d.resolution ? RESOLUTION_LABEL[d.resolution] : ADMIN_STATUS_LABEL[d.status]} {d.finishedAt ? fmtDateTime(d.finishedAt) : ''}
          {d.finalRub !== null && d.finalRub !== d.amountRub ? ` · итоговая сумма ${fmtRub0(d.finalRub)}` : ''}
        </div>
      )}

      {/* Actions */}
      <div className="ab-detail-actions">
        {actions.map((a) => (
          <button key={a} className={`adm-btn ${TONE[a]} big`} onClick={() => act(a)}>{ADMIN_ACTION_LABEL[a]}</button>
        ))}
        <button className="adm-btn contact big" onClick={() => setContact(true)}>Связаться с пользователем</button>
      </div>
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-grid">
        <Card title="Реквизиты для выплаты">
          <Row k="Сумма" v={fmtRub0(d.amountRub)} copy={String(d.amountRub)} big />
          <Row k="Способ" v={d.method === 'sbp' ? 'СБП по номеру телефона' : 'Банковская карта'} />
          {d.method === 'sbp' && (
            <>
              <Row k="Телефон" v={formatRuPhone(d.phone ?? '')} copy={`+${d.phone}`} big mono />
              <Row k="Банк" v={d.bankName ?? ''} copy={d.bankName ?? undefined} icon={<PayoutLogo method="sbp" bankId={d.bankId} destination={d.destination} size={26} />} />
            </>
          )}
          {d.method === 'card' && (
            <>
              <Row k="Номер карты" v={formatCard(d.cardNumber ?? '')} copy={d.cardNumber ?? ''} big mono />
              <Row k="Платёжная система" v={d.cardBrand ?? 'Не определена'} />
            </>
          )}
          {d.sameDestinationUsers.length > 0 && (
            <Row k="Те же реквизиты" v={d.sameDestinationUsers.map((x) => (x.username ? `@${x.username}` : x.firstName)).join(', ')} tone="warn" sub="у других аккаунтов" />
          )}
        </Card>

        <Card title="Деньги">
          <Row k="Курс сделки" v={fmtRub(d.rate)} sub={d.exchangeRate ? `Rapira ${fmtRub(d.exchangeRate)}` : undefined} />
          <Row k="Заморожено при создании" v={fmtMicroExact(d.amountMicro)} />
          <Row k="Баланс до заявки" v={fmtMicroExact(d.balanceBeforeMicro)} />
          {d.debitedMicro !== null && <Row k="Списано" v={fmtMicroExact(d.debitedMicro)} tone="ok" />}
          {d.refundedMicro !== null && d.refundedMicro > 0 && <Row k="Возвращено" v={fmtMicroExact(d.refundedMicro)} />}
          {d.reportedRub !== null && <Row k="Сообщил пользователь" v={fmtRub0(d.reportedRub)} tone="warn" />}
          {d.finalRub !== null && <Row k="Итоговая сумма" v={fmtRub0(d.finalRub)} />}
        </Card>

        <Card title="Тайминг">
          <Row k="Создана" v={fmtDateTime(d.createdAt)} />
          {d.takenAt && <Row k="Взята в работу" v={fmtDateTime(d.takenAt)} />}
          {d.enteredAt && <Row k="Исполнитель вошёл" v={fmtDateTime(d.enteredAt)} />}
          {d.requisiteOffAt && <Row k="Реквизит отключён" v={fmtDateTime(d.requisiteOffAt)} />}
          {d.userActiveAt && <Row k="На связи («ещё не поступила»)" v={fmtDateTime(d.userActiveAt)} />}
          {d.userDecidedAt && <Row k="Ответ пользователя" v={`${decision(d.userDecision)} · ${fmtDateTime(d.userDecidedAt)}`} />}
          {d.inactiveSince && <Row k="Неактивен с" v={fmtDateTime(d.inactiveSince)} />}
          {d.finishedAt && <Row k="Завершена" v={fmtDateTime(d.finishedAt)} />}
          <div className="ab-sub">Уведомления пользователю</div>
          {d.reminders.length === 0 && <div className="adm-muted small">Ещё не отправлялись</div>}
          {d.reminders.map((r) => (
            <div key={r.n} className="ab-reminder-row">
              <span>№{r.n}</span>
              <span>{fmtTime(r.at)}</span>
              <span className={r.delivered ? 't-ok' : 't-danger'}>{r.delivered ? 'доставлено' : r.error ?? 'не доставлено'}</span>
              {r.reactedAt && <span className="t-ok">«ещё не поступила» {fmtTime(r.reactedAt)}</span>}
            </div>
          ))}
        </Card>

        <Card title="ID сделки">
          {editId === null ? (
            <>
              <Row k="Ваш ID" v={d.externalId ?? 'Не назначен'} copy={d.externalId ?? undefined} tone={d.externalId ? undefined : 'warn'} />
              <button className="adm-btn small" onClick={() => setEditId(d.externalId ?? '')}>{d.externalId ? 'Изменить ID' : 'Назначить ID'}</button>
            </>
          ) : (
            <div className="adm-inline">
              <input autoFocus value={editId} onChange={(e) => setEditId(e.target.value)} placeholder="ID сделки" />
              <button className="adm-btn primary small" onClick={async () => { await api.dealAction(d.id, 'external-id', { externalId: editId }); setEditId(null); refresh(); }}>Сохранить</button>
              <button className="adm-link" onClick={() => setEditId(null)}>Отмена</button>
            </div>
          )}
          <Row k="Проверка" v={d.clientIp ?? 'IP неизвестен'} sub={[d.platform, d.userAgent].filter(Boolean).join(' · ') || undefined} small />
        </Card>

        <UserCard u={u} api={api} onDone={refresh} onOpenUser={onOpenUser} />

        <Card title="Теневые заморозки пользователя" actions={<button className="adm-link" onClick={() => setNewObligation(true)}>Создать</button>}>
          {d.obligations.length === 0 && <div className="adm-muted small">Нет</div>}
          {d.obligations.map((o) => (
            <Row
              key={o.id}
              k={`#${o.id} ${o.status === 'active' ? 'активна' : o.status === 'repaid' ? 'погашена' : 'списана'}`}
              v={`${fmtMicroExact(o.repaidMicro)} из ${fmtMicroExact(o.amountMicro)}`}
              sub={o.comment ?? o.publicReason}
              tone={o.status === 'active' ? 'warn' : undefined}
            />
          ))}
        </Card>

        {d.recentWithdrawals.length > 0 && (
          <Card title="Другие сделки пользователя">
            {d.recentWithdrawals.map((r) => (
              <button key={r.id} className="ab-mini" onClick={() => onOpenDeal(r.id)}>
                <span>№{r.id}</span>
                <span>{fmtRub0(r.finalRub ?? r.amountRub)}</span>
                <span className={`ab-chip s-${r.section ?? r.status}`}>{ADMIN_STATUS_LABEL[r.status]}</span>
                <span className="adm-muted">{fmtAgo(r.createdAt, now)}</span>
              </button>
            ))}
          </Card>
        )}
      </div>

      <Card title="История сделки">
        <Timeline events={d.events} />
        <div className="adm-inline">
          <input placeholder="Заметка для истории, видна только вам" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="adm-btn" disabled={!note.trim()} onClick={async () => { await api.dealAction(d.id, 'note', { text: note }); setNote(''); refresh(); }}>
            Добавить
          </button>
        </div>
      </Card>

      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />}
      {contact && (
        <ContactDialog
          api={api}
          user={{ ...d.user, supportLocked: !!u.supportLockedAt }}
          onClose={() => setContact(false)}
          onDone={() => { setContact(false); refresh(); }}
        />
      )}
      {newObligation && (
        <ObligationForm api={api} preset={{ userId: u.id, label: u.username ? `@${u.username}` : u.firstName, withdrawalId: d.id }} onClose={() => setNewObligation(false)} onDone={refresh} />
      )}
    </div>
  );
}

const decision = (x: AdminWithdrawalDto['userDecision']) =>
  x === 'received' ? 'оплата поступила' : x === 'not_received' ? 'оплата не поступила' : x === 'other_amount' ? 'другая сумма' : '';

export function Timeline({ events, showDeal }: { events: AdminAuditItem[]; showDeal?: boolean }) {
  return (
    <ol className="adm-timeline">
      {events.map((e) => (
        <li key={e.id} className={`actor-${e.actor}`}>
          <span className="adm-tl-time">{fmtDateTime(e.at)}</span>
          <span className="adm-tl-actor">{ACTOR[e.actor]}</span>
          <span className="adm-tl-text">
            {showDeal && e.withdrawalId ? `№${e.withdrawalId} · ` : ''}
            {eventText(e)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function eventText(e: AdminAuditItem): string {
  const x = (e.data ?? {}) as Record<string, unknown>;
  const money = [e.amountRub !== null ? fmtRub0(e.amountRub) : '', e.amountMicro !== null ? fmtMicroExact(e.amountMicro) : ''].filter(Boolean).join(' · ');
  switch (e.type) {
    case 'reminder_sent':
      return `Уведомление №${x.n} ${x.delivered ? 'доставлено' : `не доставлено: ${x.error ?? ''}`}`;
    case 'user_other_amount':
      return `${e.label}: ${fmtRub0(e.amountRub ?? 0)} вместо ${fmtRub0(Number(x.originalRub ?? 0))}`;
    case 'deal_entered':
    case 'requisite_off':
      return `${e.label}${x.requisite ? ` · ${x.requisite}` : ''}`;
    case 'deal_cancelled':
      return `${e.label}${money ? ` · ${money}` : ''}${x.reason ? ` · причина: ${x.reason}` : ''}`;
    case 'external_id_set':
      return `${e.label}: ${x.externalId ?? 'удалён'}`;
    case 'note':
      return `Заметка: ${x.text ?? ''}`;
    case 'obligation_created':
      return `${e.label} ${money}${x.comment ? ` · ${x.comment}` : ''}`;
    case 'obligation_repaid':
      return `${e.label}: ${money}${x.fully ? ', погашена полностью' : `, осталось ${fmtMicroExact(Number(x.leftMicro ?? 0))}`}`;
    case 'manual_adjustment':
      return `${e.label}: ${money}${x.comment ? ` · ${x.comment}` : ''}`;
    case 'broadcast_sent':
      return `${e.label}: ${x.recipients} получателей · «${String(x.text ?? '').slice(0, 60)}»`;
    default:
      return money ? `${e.label} · ${money}` : e.label;
  }
}
