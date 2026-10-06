// Event journal: every financial and administrative action, filterable in the admin panel.

export type AuditActor = 'user' | 'admin' | 'system';

export const AUDIT_TYPES = {
  deal_created: 'Создана сделка',
  deal_taken: 'Взята в работу',
  deal_entered: 'Исполнитель вошёл в сделку',
  requisite_off: 'Реквизит отключён',
  reminder_sent: 'Отправлено уведомление',
  user_received: 'Пользователь подтвердил получение',
  user_not_received: 'Пользователь: оплата не поступила',
  user_other_amount: 'Пользователь: другая сумма',
  deal_inactive: 'Пользователь неактивен',
  admin_confirmed: 'Подтверждено вручную',
  correction_accepted: 'Корректировка принята',
  original_accepted: 'Принято по сумме сделки',
  deal_closed: 'Сделка закрыта',
  deal_reopened: 'Возвращена на рассмотрение',
  deal_cancelled: 'Сделка отменена',
  external_id_set: 'Назначен ID сделки',
  note: 'Заметка',
  obligation_created: 'Создана теневая заморозка',
  obligation_repaid: 'Удержание по теневой заморозке',
  obligation_written_off: 'Теневая заморозка списана',
  manual_adjustment: 'Ручная корректировка баланса',
  support_lock: 'Заблокирован до связи с поддержкой',
  support_unlock: 'Блокировка снята',
  user_blocked: 'Вывод запрещён',
  user_unblocked: 'Вывод разрешён',
  deposit_credited: 'Пополнение зачислено',
  broadcast_sent: 'Рассылка',
} as const;

export type AuditType = keyof typeof AUDIT_TYPES;

/** Groups for the journal filter. */
export const AUDIT_GROUPS: { id: string; label: string; types: AuditType[] }[] = [
  { id: 'deal', label: 'Сделки', types: ['deal_created', 'deal_taken', 'deal_entered', 'requisite_off', 'deal_inactive', 'deal_closed', 'deal_reopened', 'external_id_set', 'note'] },
  { id: 'user', label: 'Действия пользователя', types: ['user_received', 'user_not_received', 'user_other_amount'] },
  { id: 'notify', label: 'Уведомления', types: ['reminder_sent', 'broadcast_sent'] },
  { id: 'money', label: 'Деньги', types: ['admin_confirmed', 'correction_accepted', 'original_accepted', 'deal_cancelled', 'manual_adjustment', 'deposit_credited'] },
  { id: 'shadow', label: 'Теневые заморозки', types: ['obligation_created', 'obligation_repaid', 'obligation_written_off'] },
  { id: 'access', label: 'Доступ', types: ['support_lock', 'support_unlock', 'user_blocked', 'user_unblocked'] },
];
