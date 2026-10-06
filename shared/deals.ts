// Lifecycle of a USDT → RUB withdrawal deal. The operator pays through an external
// platform by hand; this module is the single source of truth for statuses, timings,
// who may do what, and the money maths. Used by the backend, the Mini App and the demo.

import { usdtMicroForRub } from './payout.js';

export type DealStatus =
  | 'new' // created, USDT frozen, the operator has not started
  | 'in_work' // taken by the operator, the deal is being created on the platform
  | 'entered' // an executor entered the platform deal; reminders go to the user
  | 'user_confirmed' // the user confirmed receipt, USDT written off; the operator closes the platform deal
  | 'not_received' // the user says the money did not arrive
  | 'mismatch' // the user received a different amount
  | 'inactive' // the user did not answer in time
  | 'completed' // archived: paid out
  | 'cancelled'; // archived: cancelled, USDT returned

export const ACTIVE_STATUSES: DealStatus[] = ['new', 'in_work', 'entered', 'user_confirmed', 'not_received', 'mismatch', 'inactive'];
export const isDealFinal = (s: DealStatus) => s === 'completed' || s === 'cancelled';

const MIN = 60_000;
/** First reminder 2 minutes after "executor entered", then every 2 minutes. */
export const REMINDER_INTERVAL_MS = 2 * MIN;
export const REMINDER_COUNT = 5;
/** No answer 2 minutes after the 5th reminder: the deal becomes "inactive". */
export const INACTIVE_AFTER_MS = (REMINDER_COUNT + 1) * REMINDER_INTERVAL_MS;
/** The external platform drops an active deal 15 minutes after the executor entered it. */
export const PLATFORM_TIMER_MS = 15 * MIN;

/** How many reminders should have gone out by `now` (0-5). */
export function remindersDue(enteredAt: number, now: number): number {
  return Math.max(0, Math.min(REMINDER_COUNT, Math.floor((now - enteredAt) / REMINDER_INTERVAL_MS)));
}

export const nextReminderAt = (enteredAt: number, sent: number) =>
  sent >= REMINDER_COUNT ? null : enteredAt + (sent + 1) * REMINDER_INTERVAL_MS;

// ---------- Archive outcome ----------

export type DealResolution =
  | 'closed' // the user confirmed, the operator closed the platform deal
  | 'confirmed_admin' // the operator confirmed it himself
  | 'correction' // paid by the amount the user reported
  | 'original' // the user reported another amount, paid by the original one
  | 'cancelled';

export const RESOLUTION_LABEL: Record<DealResolution, string> = {
  closed: 'Подтверждено пользователем и закрыто',
  confirmed_admin: 'Подтверждено вручную',
  correction: 'Принята корректировка',
  original: 'Принято по сумме сделки',
  cancelled: 'Отменена',
};

// ---------- Operator actions ----------

export type AdminDealAction =
  | 'take'
  | 'entered'
  | 'requisite_off'
  | 'confirm'
  | 'close'
  | 'reopen'
  | 'accept_correction'
  | 'accept_original'
  | 'cancel';

const ADMIN_FROM: Record<AdminDealAction, DealStatus[]> = {
  take: ['new'],
  entered: ['in_work'],
  // Only clears the reminder; allowed while the deal is alive after "entered".
  requisite_off: ['entered', 'user_confirmed', 'not_received', 'mismatch', 'inactive'],
  confirm: ['entered', 'not_received', 'inactive'],
  close: ['user_confirmed'],
  // A user who confirmed by mistake: back to review, USDT frozen again.
  reopen: ['user_confirmed'],
  accept_correction: ['mismatch'],
  accept_original: ['mismatch'],
  // Returns frozen USDT. Not after the user's confirmation: those USDT are already written off.
  cancel: ['new', 'in_work', 'entered', 'not_received', 'mismatch', 'inactive'],
};

export const ADMIN_TO: Partial<Record<AdminDealAction, DealStatus>> = {
  take: 'in_work',
  entered: 'entered',
  confirm: 'completed',
  close: 'completed',
  reopen: 'not_received',
  accept_correction: 'completed',
  accept_original: 'completed',
  cancel: 'cancelled',
};

/** Actions that send the deal to the archive: the UI offers to set a deal ID first. */
export const ARCHIVING_ACTIONS: AdminDealAction[] = ['confirm', 'close', 'accept_correction', 'accept_original', 'cancel'];

export const adminCan = (status: DealStatus, action: AdminDealAction) => ADMIN_FROM[action].includes(status);

export const ADMIN_ACTION_LABEL: Record<AdminDealAction, string> = {
  take: 'Взять в работу',
  entered: 'В сделку вошли',
  requisite_off: 'ОТКЛЮЧИЛ',
  confirm: 'Подтвердить вручную',
  close: 'Подтверждено / Закрыть сделку',
  reopen: 'Вернуть на рассмотрение',
  accept_correction: 'Принять корректировку',
  accept_original: 'Принять по сумме сделки',
  cancel: 'Отменить сделку',
};

// ---------- User actions ----------

export type UserDealAction = 'received' | 'not_received' | 'other_amount';

export interface DealTiming {
  status: DealStatus;
  enteredAt: number | null;
}

/**
 * What the user may press right now. Nothing before the first reminder (the money
 * may still be on its way); "not received" only from the 5th reminder on, so people
 * do not press it while the bank is still processing the transfer.
 */
export function userActions(d: DealTiming, now: number): UserDealAction[] {
  switch (d.status) {
    case 'entered': {
      if (d.enteredAt === null || now < d.enteredAt + REMINDER_INTERVAL_MS) return [];
      const last = now >= d.enteredAt + REMINDER_COUNT * REMINDER_INTERVAL_MS;
      return last ? ['received', 'not_received', 'other_amount'] : ['received', 'other_amount'];
    }
    case 'not_received':
      return ['received', 'other_amount'];
    case 'mismatch':
    case 'inactive':
      return ['received', 'not_received', 'other_amount'];
    default:
      return [];
  }
}

export const userCan = (d: DealTiming, action: UserDealAction, now: number) => userActions(d, now).includes(action);

/** What the user sees as the deal status in the Mini App. */
export function userStatusLabel(d: DealTiming, now: number): string {
  switch (d.status) {
    case 'new':
    case 'in_work':
      return 'В обработке';
    case 'entered':
      return userActions(d, now).length ? 'Подтвердите получение' : 'В обработке';
    case 'user_confirmed':
    case 'completed':
      return 'Выполнено';
    case 'not_received':
      return 'Проверяем платёж';
    case 'mismatch':
      return 'Проверяем сумму';
    case 'inactive':
      return 'Ждём подтверждения';
    case 'cancelled':
      return 'Отменено';
  }
}

export const ADMIN_STATUS_LABEL: Record<DealStatus, string> = {
  new: 'Новая',
  in_work: 'В работе',
  entered: 'В сделке',
  user_confirmed: 'Подтверждено пользователем',
  not_received: 'Оплата не поступила',
  mismatch: 'Корректировка суммы',
  inactive: 'Пользователь неактивен',
  completed: 'Выполнена',
  cancelled: 'Отменена',
};

// ---------- Admin board ----------

export type BoardSection =
  | 'user_confirmed'
  | 'requisite'
  | 'mismatch'
  | 'not_received'
  | 'inactive'
  | 'new'
  | 'in_work'
  | 'awaiting';

/** Most urgent first. */
export const BOARD_SECTIONS: { id: BoardSection; title: string; hint: string }[] = [
  { id: 'user_confirmed', title: 'Подтверждено пользователем', hint: 'Закройте сделку на площадке' },
  { id: 'requisite', title: 'Отключите реквизит', hint: 'Исполнитель в сделке' },
  { id: 'mismatch', title: 'Корректировка суммы', hint: 'Пользователь получил другую сумму' },
  { id: 'not_received', title: 'Оплата не поступила', hint: 'Нужно ваше решение' },
  { id: 'inactive', title: 'Пользователь неактивен', hint: 'Не ответил на уведомления' },
  { id: 'new', title: 'Новые', hint: 'Ещё не взяты в работу' },
  { id: 'in_work', title: 'В работе', hint: 'Ждём исполнителя на площадке' },
  { id: 'awaiting', title: 'Ждём пользователя', hint: 'Уведомления отправляются' },
];

export function boardSection(d: { status: DealStatus; requisiteOffAt: number | null }): BoardSection | null {
  switch (d.status) {
    case 'user_confirmed':
      return 'user_confirmed';
    case 'entered':
      return d.requisiteOffAt ? 'awaiting' : 'requisite';
    case 'mismatch':
    case 'not_received':
    case 'inactive':
    case 'new':
    case 'in_work':
      return d.status;
    default:
      return null;
  }
}

// ---------- Reminders ----------

export interface ReminderMessage {
  text: string;
  /** Button labels follow the reminder: the 5th one is the final call. */
  receivedLabel: string;
}

export function reminderMessage(n: number, amountRub: number, dealId: number): ReminderMessage {
  const sum = `${amountRub.toLocaleString('ru-RU')} ₽`;
  if (n >= REMINDER_COUNT) {
    return {
      text:
        `Подтвердите оплату по заявке №${dealId}: деньги должны были поступить (${sum}).\n\n` +
        'Если вы не сделаете это в течение 2 минут, сделка будет переведена системой в состояние неактивности и останется на рассмотрении администратора.',
      receivedLabel: 'Оплата поступила',
    };
  }
  const head =
    n === 1
      ? `Деньги начали путь. Проверьте счёт и подтвердите поступление ${sum} по заявке №${dealId}.`
      : `Напоминание: проверьте поступление ${sum} по заявке №${dealId} и подтвердите получение.`;
  const tail =
    n === REMINDER_COUNT - 1
      ? 'Следующее уведомление будет последним.'
      : 'Чем быстрее вы подтверждаете получение, тем выше ваш рейтинг и тем выгоднее курс для вас.';
  return { text: `${head}\n\n${tail}`, receivedLabel: 'Подтвердить получение' };
}

// ---------- Corrections ----------

export interface CorrectionPlan {
  /** USDT the reported amount is worth at the deal's own rate. */
  correctedMicro: number;
  /** Frozen USDT returned to the balance (reported amount below the original). */
  refundMicro: number;
  /** USDT owed above the frozen amount (reported amount above the original). */
  extraMicro: number;
  /** Part of the extra taken from the available balance right away. */
  fromAvailableMicro: number;
  /** Part of the extra the balance cannot cover: becomes a shadow obligation if the operator wants. */
  shortageMicro: number;
}

/** The deal rate is never re-quoted: the reported rubles are converted at the rate fixed at creation. */
export function correctionPlan(amountMicro: number, rate: number, reportedRub: number, availableMicro: number): CorrectionPlan {
  const correctedMicro = reportedRub > 0 ? usdtMicroForRub(reportedRub, rate) : 0;
  const refundMicro = Math.max(0, amountMicro - correctedMicro);
  const extraMicro = Math.max(0, correctedMicro - amountMicro);
  const fromAvailableMicro = Math.min(extraMicro, Math.max(0, availableMicro));
  return { correctedMicro, refundMicro, extraMicro, fromAvailableMicro, shortageMicro: extraMicro - fromAvailableMicro };
}

export const MAX_REPORTED_RUB = 10_000_000;

export function validateReportedRub(rub: number): string | null {
  if (!Number.isInteger(rub) || rub <= 0) return 'Введите сумму в рублях';
  if (rub > MAX_REPORTED_RUB) return 'Слишком большая сумма';
  return null;
}
