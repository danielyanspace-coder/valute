import { useEffect, useState } from 'react';
import type { DepositInfoDto } from '../../../../shared/api';
import { shortUsdt } from '../../../../shared/transfers';
import { api } from '../../lib/backend';
import { copyText, haptic, hapticNotify, tg } from '../../lib/telegram';
import { CoinIcon } from '../CoinIcon';
import { IconAlert, IconCheck, IconClock, IconCopy } from '../icons';
import { Sheet } from '../Sheet';
import { QrCode } from './QrCode';

/** Deposit screen: USDT on TRON (TRC-20) only, one personal address per user. */
export function DepositSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<DepositInfoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setError(null);
    api.deposit().then(setInfo, (e) => setError((e as Error).message));
  }, [open]);

  const copy = async () => {
    if (!info?.address) return;
    haptic();
    if (await copyText(info.address)) {
      hapticNotify('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const share = () => {
    if (!info?.address) return;
    const text = `Мой адрес USDT (сеть TRON, TRC-20): ${info.address}`;
    if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(info.address)}&text=${encodeURIComponent(text)}`);
    else if (navigator.share) navigator.share({ text }).catch(() => {});
    else void copy();
  };

  const min = info ? shortUsdt(info.minDepositMicro) : '1';

  return (
    <Sheet open={open} onClose={onClose} title="Пополнить">
      <div className="deposit">
        <div className="dep-asset">
          <CoinIcon symbol="USDT" size={42} />
          <div className="dep-asset-text">
            <b>USDT</b>
            <span className="muted">Tether</span>
          </div>
          <span className="dep-network"><TronMark /> TRON · TRC-20</span>
        </div>

        {info?.address ? (
          <div className="dep-card">
            <div className="dep-qr"><QrCode value={info.address} size={208} /></div>
            <span className="dep-label">Ваш адрес для пополнения</span>
            <div className="dep-address" onClick={copy}>
              <span className="hl">{info.address.slice(0, 6)}</span>
              {info.address.slice(6, -6)}
              <span className="hl">{info.address.slice(-6)}</span>
            </div>
            {info.demo && <span className="dep-demo">Демо-адрес, он не настоящий. Не отправляйте на него средства</span>}
            <div className="dep-actions">
              <button className="btn primary" onClick={copy}>
                {copied ? <><IconCheck size={16} /> Скопировано</> : <><IconCopy size={16} /> Скопировать</>}
              </button>
              <button className="btn ghost" onClick={share}>Поделиться</button>
            </div>
          </div>
        ) : (
          <div className="dep-card pending">
            <div className="dep-qr placeholder">
              <div className="dep-qr-blur" />
              <span className="dep-qr-icon"><IconClock size={26} /></span>
            </div>
            <b className="dep-pending-title">{error ? 'Не удалось загрузить адрес' : info ? 'Адрес готовится' : 'Загружаем…'}</b>
            <p className="muted dep-pending-text">
              {error ?? 'Пополнение скоро заработает. Здесь появится ваш личный адрес USDT в сети TRON и QR-код к нему.'}
            </p>
          </div>
        )}

        <div className="dep-warning">
          <IconAlert size={18} />
          <p>
            Отправляйте только <b>USDT</b> в сети <b>TRON (TRC-20)</b>. Другие монеты и сети (ERC-20, BEP-20, TON) не зачислятся,
            и вернуть их не получится.
          </p>
        </div>

        <div className="kv-list dep-facts">
          <div className="kv"><span className="muted">Сеть</span><span>TRON (TRC-20)</span></div>
          <div className="kv"><span className="muted">Минимум</span><span>{min} USDT</span></div>
          <div className="kv"><span className="muted">Зачисление</span><span>{info?.confirmations ?? 20} подтверждений, 1-2 минуты</span></div>
          <div className="kv"><span className="muted">Комиссия кошелька</span><span className="up">0 USDT</span></div>
        </div>

        <div className="dep-steps">
          <b>Как пополнить</b>
          <ol>
            <li>Скопируйте адрес или отсканируйте QR-код.</li>
            <li>На бирже или в кошельке выберите вывод USDT и сеть <b>TRC-20</b>.</li>
            <li>Деньги появятся на балансе автоматически, бот пришлёт уведомление.</li>
          </ol>
          <p className="muted small">Сумма меньше {min} USDT не зачисляется. Все поступления проходят автоматическую AML-проверку.</p>
        </div>
      </div>
    </Sheet>
  );
}

function TronMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#eb0029" />
      <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M6 6.8 18.2 9.4 11.6 18.6Z" />
        <path d="M6 6.8 13.6 11.2 18.2 9.4M13.6 11.2 11.6 18.6" />
      </g>
    </svg>
  );
}
