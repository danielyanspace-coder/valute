import { useMemo, useState } from 'react';
import { searchBanks, type SbpBank } from '../../../../shared/sbpBanks';
import { IconCheck, IconSearch } from '../icons';

const PALETTE = ['#4f6bed', '#2fa37a', '#c0577a', '#c98a2b', '#7a5cd6', '#2e8fb8', '#b5523c'];

function initials(name: string): string {
  const clean = name.replace(/[«»"()]/g, '').replace(/^(Банк|КБ|АКБ|АБ|НКО|ПНКО|ИК)\s+/i, '');
  const words = clean.split(/[\s-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
}

export function BankAvatar({ bank, size = 36 }: { bank: SbpBank; size?: number }) {
  const color = bank.color ?? PALETTE[Number(bank.id.slice(-3)) % PALETTE.length];
  const light = /^#(f|e|d)/i.test(color); // yellow brands (Т-Банк, Райффайзен) need dark text
  return (
    <span className="bank-avatar" style={{ width: size, height: size, background: color, color: light ? '#111' : '#fff', fontSize: size * 0.36 }}>
      {initials(bank.name)}
    </span>
  );
}

export function BankPicker({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchBanks(query), [query]);
  const popular = !query ? results.filter((b) => b.popular) : [];
  const rest = !query ? results.filter((b) => !b.popular) : results;

  const row = (b: SbpBank) => (
    <button key={b.id} className={`bank-row ${b.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(b.id)}>
      <BankAvatar bank={b} />
      <span className="bank-name">
        {b.name}
        {b.official && query && <small className="muted">{b.official}</small>}
      </span>
      {b.id === selectedId && <IconCheck size={18} className="bank-check" />}
    </button>
  );

  return (
    <div className="bank-picker">
      <div className="search">
        <IconSearch size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск банка" />
        {query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Очистить">×</button>}
      </div>
      <div className="bank-list">
        {popular.length > 0 && (
          <>
            <div className="list-label">Популярные</div>
            {popular.map(row)}
            <div className="list-label">Все банки</div>
          </>
        )}
        {rest.map(row)}
        {results.length === 0 && <div className="empty">Банк не найден. Попробуйте другое название</div>}
      </div>
    </div>
  );
}
