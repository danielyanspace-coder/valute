// IX Black: the paid status. Plain data shared by the server, the Mini App and the bot.

import { USDT_MICRO } from './payout.js';

export const PREMIUM_NAME = 'IX Black';

export type PremiumPlan = 'month' | 'quarter';

export interface PremiumPlanInfo {
  id: PremiumPlan;
  title: string;
  days: number;
  priceMicro: number;
  /** Shown next to the price, e.g. "выгода 11%". */
  note: string | null;
}

export const PREMIUM_PLANS: PremiumPlanInfo[] = [
  { id: 'month', title: '1 месяц', days: 30, priceMicro: 14_990_000, note: null },
  { id: 'quarter', title: '3 месяца', days: 90, priceMicro: 39_990_000, note: 'выгода 11%' },
];

export const premiumPlan = (id: string): PremiumPlanInfo | undefined => PREMIUM_PLANS.find((p) => p.id === id);

/** Monthly cashback on turnover: 20 basis points = 0.2%. */
export const PREMIUM_CASHBACK_BPS = 20;
/** Cashback smaller than this is not worth a ledger row. */
export const PREMIUM_CASHBACK_MIN_MICRO = USDT_MICRO / 100;

export interface PremiumPerk {
  key: 'priority' | 'support' | 'cashback' | 'badge';
  title: string;
  text: string;
}

export const PREMIUM_PERKS: PremiumPerk[] = [
  {
    key: 'priority',
    title: 'Заявки без очереди',
    text: 'Выводы на карту, в USDT и оплата услуг обрабатываются первыми, раньше всех остальных заявок.',
  },
  {
    key: 'support',
    title: 'Приоритетная поддержка',
    text: 'Отдельная линия: ваши обращения разбираются в первую очередь.',
  },
  {
    key: 'cashback',
    title: 'Кэшбэк 0.2% от оборота',
    text: 'В начале месяца на баланс возвращается 0.2% от суммы выводов и оплат услуг за прошлый месяц.',
  },
  {
    key: 'badge',
    title: 'Знак IX Black',
    text: 'Отличительный знак в профиле и в заявках.',
  },
];

export const PREMIUM_FINE_PRINT = 'Оплата с баланса, без автопродления. Новый срок добавляется к текущему. Статус не влияет на курс и шансы в розыгрышах.';
