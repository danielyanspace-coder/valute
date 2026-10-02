import { useEffect, type ReactNode } from 'react';
import { IconChevronLeft, IconClose } from './icons';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shows a back arrow instead of leaving the user to close and start over. */
  onBack?: () => void;
  title?: string;
  /** Full-height sheet for lists and multi-step forms. */
  tall?: boolean;
  children: ReactNode;
}

export function Sheet({ open, onClose, onBack, title, tall, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet ${tall ? 'tall' : ''}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          {onBack && (
            <button className="icon-btn sm" onClick={onBack} aria-label="Назад"><IconChevronLeft size={18} /></button>
          )}
          <h3>{title}</h3>
          <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
