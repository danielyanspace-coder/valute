import type { ReactNode } from 'react';
import { IconArrowUpRight, IconPlus, IconQr, IconSwap } from './icons';

export type ActionId = 'deposit' | 'withdraw' | 'transfer' | 'pay';

const ACTIONS: { id: ActionId; label: string; icon: ReactNode }[] = [
  { id: 'deposit', label: 'Пополнить', icon: <IconPlus size={26} /> },
  { id: 'withdraw', label: 'Вывести', icon: <IconArrowUpRight size={24} /> },
  { id: 'transfer', label: 'Перевести', icon: <IconSwap size={24} /> },
  { id: 'pay', label: 'Оплатить', icon: <IconQr size={24} /> },
];

export function Actions({ onAction }: { onAction: (id: ActionId) => void }) {
  return (
    <nav className="actions">
      {ACTIONS.map((a) => (
        <button key={a.id} className="card action" onClick={() => onAction(a.id)}>
          <span className="action-icon">{a.icon}</span>
          <span>{a.label}</span>
        </button>
      ))}
    </nav>
  );
}
