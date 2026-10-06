// What every operator action asks before it runs: one place for texts and money previews.
import type { AdminWithdrawalDto, AdminWithdrawalListItem } from '../../../shared/api';
import { ADMIN_ACTION_LABEL, INACTIVE_AFTER_MS, type AdminDealAction } from '../../../shared/deals';
import type { AdminApi, DealActionPath } from '../lib/api';
import { fmtMicroExact, fmtRub, fmtRub0 } from '../lib/format';
import type { ConfirmRequest } from './ui';

const PATH: Record<AdminDealAction, DealActionPath> = {
  take: 'take',
  entered: 'entered',
  requisite_off: 'requisite-off',
  confirm: 'confirm',
  close: 'close',
  reopen: 'reopen',
  accept_correction: 'accept-correction',
  accept_original: 'accept-original',
  cancel: 'cancel',
};

type Deal = AdminWithdrawalListItem | AdminWithdrawalDto;

const isFull = (d: Deal): d is AdminWithdrawalDto => 'events' in d;

/** Actions that run without a confirmation window. */
export const INSTANT: AdminDealAction[] = ['requisite_off'];

export function runInstant(api: AdminApi, d: Deal, action: AdminDealAction) {
  return api.dealAction(d.id, PATH[action]);
}

/**
 * Builds the confirmation for an action. The correction needs the full deal (rate,
 * balance), so it loads it when called from a board card.
 */
export async function confirmFor(api: AdminApi, deal: Deal, action: AdminDealAction, after: () => void): Promise<ConfirmRequest> {
  const d = action === 'accept_correction' && !isFull(deal) ? await api.deal(deal.id) : deal;
  const no = `№${d.id}`;
  const usdt = fmtMicroExact(d.amountMicro);
  const run = (body: (i: { externalId: string; reason: string; checked: boolean }) => Record<string, unknown> = () => ({})) => async (i: {
    externalId: string;
    reason: string;
    checked: boolean;
  }) => {
    await api.dealAction(d.id, PATH[action], body(i));
    after();
  };
  const withId = (i: { externalId: string }) => ({ externalId: i.externalId });

  switch (action) {
    case 'take':
      return {
        title: `Взять в работу ${no}?`,
        text: <>{fmtRub0(d.amountRub)} · {d.destination}. Заявка станет оранжевой, повторно её не взять.</>,
        confirmLabel: 'Взять в работу',
        tone: 'primary',
        run: run(),
      };
    case 'entered':
      return {
        title: `Исполнитель вошёл в сделку ${no}?`,
        text: (
          <>
            <p>Через 2 минуты пользователь получит первое уведомление, всего их будет 5. Без ответа через {INACTIVE_AFTER_MS / 60_000} минут сделка станет неактивной.</p>
            <p><b>Сразу отключите приём сделок для реквизита {d.requisite}</b> на площадке.</p>
          </>
        ),
        confirmLabel: 'В сделку вошли',
        tone: 'warn',
        run: run(),
      };
    case 'confirm':
      return {
        title: `Подтвердить ${no} вручную?`,
        text: <>Сделка считается состоявшейся: с пользователя спишется {usdt} за {fmtRub0(d.amountRub)}. Сделка уйдёт в архив.</>,
        confirmLabel: 'Подтвердить',
        tone: 'success',
        askExternalId: true,
        run: run(withId),
      };
    case 'close':
      return {
        title: `Закрыть сделку ${no}?`,
        text: <>Пользователь подтвердил получение {fmtRub0(d.amountRub)}, USDT уже списаны. Убедитесь, что сделка подтверждена на площадке.</>,
        confirmLabel: 'Закрыть сделку',
        tone: 'success',
        askExternalId: true,
        run: run(withId),
      };
    case 'reopen':
      return {
        title: `Вернуть ${no} на рассмотрение?`,
        text: <>Списанные {usdt} снова заморозятся, сделка перейдёт в «Оплата не поступила». Пользователь снова увидит кнопки ответа.</>,
        confirmLabel: 'Вернуть',
        tone: 'warn',
        run: run(),
      };
    case 'accept_correction': {
      const full = d as AdminWithdrawalDto;
      const c = full.correction!;
      return {
        title: `Принять корректировку ${no}?`,
        text: (
          <>
            <p>Пользователь получил <b>{fmtRub0(c.reportedRub)}</b> вместо {fmtRub0(d.amountRub)}. Пересчёт по курсу сделки {fmtRub(full.rate)}:</p>
            <ul className="ab-calc">
              <li>Спишется: <b>{fmtMicroExact(c.correctedMicro - c.shortageMicro)}</b></li>
              {c.refundMicro > 0 && <li>Вернётся на баланс: <b>{fmtMicroExact(c.refundMicro)}</b></li>}
              {c.fromAvailableMicro > 0 && <li>Из них с доступного баланса: <b>{fmtMicroExact(c.fromAvailableMicro)}</b></li>}
              {c.shortageMicro > 0 && <li className="t-warn">Не хватает на балансе: <b>{fmtMicroExact(c.shortageMicro)}</b></li>}
            </ul>
          </>
        ),
        confirmLabel: 'Принять корректировку',
        tone: 'primary',
        askExternalId: true,
        checkbox: c.shortageMicro > 0 ? { label: `Создать теневую заморозку на ${fmtMicroExact(c.shortageMicro)}`, defaultChecked: true } : undefined,
        run: run((i) => ({ externalId: i.externalId, createObligation: i.checked })),
      };
    }
    case 'accept_original':
      return {
        title: `Принять ${no} по сумме сделки?`,
        text: <>Спишется {usdt} за {fmtRub0(d.amountRub)}. Сумма, которую сообщил пользователь ({fmtRub0(d.reportedRub ?? 0)}), не учитывается.</>,
        confirmLabel: 'Принять по сумме сделки',
        tone: 'success',
        askExternalId: true,
        run: run(withId),
      };
    case 'cancel':
      return {
        title: `Отменить сделку ${no}?`,
        text: <>Сделка признаётся несостоявшейся: {usdt} вернутся пользователю на баланс. Сделка уйдёт в архив.</>,
        confirmLabel: 'Отменить сделку',
        tone: 'danger',
        askExternalId: true,
        reasonLabel: 'Причина (для журнала)',
        run: run((i) => ({ externalId: i.externalId, reason: i.reason })),
      };
    case 'requisite_off':
      return { title: ADMIN_ACTION_LABEL.requisite_off, text: '', confirmLabel: 'ОТКЛЮЧИЛ', tone: 'warn', run: run() };
  }
}
