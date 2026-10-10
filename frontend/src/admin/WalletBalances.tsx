import { useCallback, useState } from 'react';
import type { AdminWalletBalancesDto } from '../../../shared/api';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtMicro } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { CopyChip, useNow } from './ui';

const trx = (sun: number) => `${(sun / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} TRX`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;

/**
 * "Balance on all wallets": real USDT on every deposit address and own wallet, read from
 * the chain. Folded it is one number; unfolded it shows how much sits on each wallet.
 * With owedMicro it also compares the total with what the wallet owes its clients.
 */
export function WalletBalances({ api, owedMicro }: { api: AdminApi; owedMicro?: number }) {
  const [data, setData] = useState<AdminWalletBalancesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(0);

  const load = useCallback(
    (refresh = false) => {
      if (refresh) setBusy(true);
      api
        .walletBalances(refresh)
        .then((d) => { setData(d); setError(null); }, (e) => setError((e as Error).message))
        .finally(() => setBusy(false));
    },
    [api],
  );
  usePolling(load, 60_000);

  const reserve = data && owedMicro !== undefined ? data.totalUsdtMicro - owedMicro : null;
  const rows = data ? [...data.items].sort((a, b) => (b.usdtMicro ?? -1) - (a.usdtMicro ?? -1) || Number(b.own) - Number(a.own)) : [];

  return (
    <section className="adm-card wb">
      <div className="adm-card-head">
        <div className="adm-card-title">Баланс на всех кошельках</div>
        <button className="adm-btn wb-refresh" disabled={busy} onClick={() => load(true)}>{busy ? 'Обновляю…' : 'Обновить'}</button>
      </div>

      {!data && <div className="adm-muted small">{error ?? 'Читаю балансы из сети TRON…'}</div>}
      {data && (
        <>
          <div className="wb-total">{fmtMicro(data.totalUsdtMicro)}</div>
          <div className="wb-split">
            <span>Адреса пополнения <b>{fmtMicro(data.poolUsdtMicro)}</b></span>
            <span>Мои кошельки <b>{fmtMicro(data.ownUsdtMicro)}</b></span>
            <span>TRX на комиссии <b>{trx(data.totalTrxSun)}</b></span>
          </div>
          {reserve !== null && (
            <div className={`wb-reserve ${reserve >= 0 ? 't-ok' : 't-danger'}`}>
              Балансы клиентов {fmtMicro(owedMicro!)} · {reserve >= 0 ? `запас ${fmtMicro(reserve)}` : `не хватает ${fmtMicro(-reserve)}`}
            </div>
          )}
          {data.failed > 0 && (
            <div className="wb-warn">Не удалось прочитать {data.failed} из {data.items.length}: для них показан последний известный баланс. Нажмите «Обновить».</div>
          )}
          {error && <div className="wb-warn">{error}</div>}

          <button className="wb-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className={`wb-caret ${open ? 'open' : ''}`}>▸</span> По кошелькам ({data.items.length})
          </button>
          {open && (
            <div className="wb-list">
              {rows.length === 0 && <div className="adm-muted small">Кошельков нет. Добавьте адреса в «Пополнения → Адреса».</div>}
              {rows.map((w) => (
                <div key={w.id} className={`wb-row ${w.error ? 'failed' : ''}`}>
                  <div className="wb-name">
                    <span className={`dp-chip ${w.own ? 'own' : 'ok'}`}>{w.own ? 'Мой' : 'Пополнение'}</span>
                    <b>{w.label || `Адрес ${w.id}`}</b>
                  </div>
                  <div className="wb-addr" onClick={(e) => e.stopPropagation()}>
                    <code title={w.address}>{short(w.address)}</code>
                    <CopyChip label="Копировать" value={w.address} />
                    <a className="wb-link" href={`https://tronscan.org/#/address/${w.address}`} target="_blank" rel="noreferrer">Tronscan</a>
                  </div>
                  <div className="wb-amount">
                    <b>{w.usdtMicro === null ? '—' : fmtMicro(w.usdtMicro)}</b>
                    <span>{w.trxSun === null ? '' : trx(w.trxSun)}{w.error ? ' · не обновился' : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="adm-muted small wb-time">Обновлено {fmtAgo(data.checkedAt, now)} · данные из сети TRON</div>
        </>
      )}
    </section>
  );
}
