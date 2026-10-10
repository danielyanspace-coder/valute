import { useCallback, useState } from 'react';
import type { AdminDepositAddressDto } from '../../../shared/api';
import { DEPOSIT_QUARANTINE_MS, DEPOSIT_REQUEST_TTL_MS } from '../../../shared/deposits';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtCountdown, fmtMicroExact } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { CopyChip, useNow } from './ui';
import { WalletBalances } from './WalletBalances';

const STATE: Record<AdminDepositAddressDto['state'], { label: string; cls: string }> = {
  free: { label: 'Свободен', cls: 'ok' },
  busy: { label: 'Выдан', cls: 'busy' },
  quarantine: { label: 'Карантин', cls: 'warn' },
  off: { label: 'Выключен', cls: 'off' },
  own: { label: 'Мой кошелёк', cls: 'own' },
};

const who = (u: NonNullable<AdminDepositAddressDto['holder']>) => (u.username ? `@${u.username}` : `${u.firstName} (ID ${u.id})`);

/** The address pool: TronLink accounts lent to users one request at a time, plus own wallets. */
export function DepositPool({ api }: { api: AdminApi }) {
  const [items, setItems] = useState<AdminDepositAddressDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(0);

  const load = useCallback(() => {
    api.depositPool().then((r) => setItems(r.items), (e) => setError((e as Error).message));
  }, [api]);
  usePolling(load, 5000);

  const run = async (fn: () => Promise<{ items: AdminDepositAddressDto[] }>) => {
    setBusy(true);
    setError(null);
    try {
      setItems((await fn()).items);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (await run(() => api.depositPoolAdd(address, label, own))) {
      setAddress('');
      setLabel('');
      setOwn(false);
    }
  };

  const lendable = items?.filter((p) => !p.own && p.enabled).length ?? 0;
  const free = items?.filter((p) => p.state === 'free').length ?? 0;

  return (
    <div className="dp">
      <div className="adm-banner small">
        <span>
          Каждый пользователь получает свободный адрес на {DEPOSIT_REQUEST_TTL_MS / 60_000} минут. После заявки адрес ещё{' '}
          {DEPOSIT_QUARANTINE_MS / 60_000} минут никому не выдаётся, чтобы опоздавший перевод зачислился тому же человеку.
          Сиды остаются в TronLink, сюда добавляются только публичные адреса.
        </span>
        <span>
          <b>Мой кошелёк</b>: основной TronLink и любые ваши кошельки. Они никому не выдаются, а переводы с них на адреса пополнения не считаются пополнениями.
          Не отправляйте USDT на адреса пополнения с биржи сами: такой перевод зачислится тому, кто держит адрес.
        </span>
      </div>

      <WalletBalances api={api} />

      <div className="dp-summary">
        <div><b>{lendable}</b><span>включено</span></div>
        <div><b>{free}</b><span>свободно сейчас</span></div>
        <div><b>{items?.filter((p) => p.state === 'busy').length ?? 0}</b><span>выдано</span></div>
        <div><b>{items?.filter((p) => p.state === 'quarantine').length ?? 0}</b><span>в карантине</span></div>
      </div>

      <div className="adm-card dp-add">
        <div className="adm-card-title">Добавить адрес</div>
        <div className="dp-add-row">
          <input id="pool-address" placeholder="Адрес TRON, начинается на T" value={address} onChange={(e) => setAddress(e.target.value.trim())} spellCheck={false} />
          <input id="pool-label" placeholder="Подпись, например «Аккаунт 3»" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="adm-btn primary" disabled={busy || !address} onClick={add}>Добавить</button>
        </div>
        <label className="dp-own">
          <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          Это мой кошелёк, не выдавать пользователям
        </label>
      </div>

      {error && <div className="adm-error">{error}</div>}
      {items && items.length === 0 && <div className="adm-empty">Адресов пока нет. Добавьте 10 аккаунтов из TronLink.</div>}

      <div className="dp-list">
        {items?.map((p) => {
          const s = STATE[p.state];
          return (
            <div key={p.id} className={`dp-row ${p.state}`}>
              <div className="dp-main">
                <div className="dp-top">
                  <span className={`dp-chip ${s.cls}`}>{s.label}</span>
                  <b>{p.label || `Адрес ${p.id}`}</b>
                  {p.holder && <span className="dp-holder">{who(p.holder)}</span>}
                  {p.until && <span className="dp-until">{p.state === 'busy' ? 'заявка ещё' : 'освободится через'} {fmtCountdown(p.until - now)}</span>}
                </div>
                <div className="dp-addr">
                  <code>{p.address}</code>
                  <CopyChip label="Копировать" value={p.address} />
                </div>
                {!p.own && (
                  <div className="adm-muted small">
                    Зачислено {p.depositsCount} · {fmtMicroExact(p.receivedMicro)}
                    {p.lastCheckedAt ? ` · проверен ${fmtAgo(p.lastCheckedAt, now)}` : ' · ещё не проверялся'}
                  </div>
                )}
              </div>
              <div className="dp-actions">
                {!p.own && (
                  <button className="adm-btn" disabled={busy} onClick={() => run(() => api.depositPoolUpdate(p.id, { enabled: !p.enabled }))}>
                    {p.enabled ? 'Выключить' : 'Включить'}
                  </button>
                )}
                {(p.own || p.depositsCount === 0) && (
                  <button className="adm-btn danger-ghost" disabled={busy} onClick={() => run(() => api.depositPoolRemove(p.id))}>Удалить</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
