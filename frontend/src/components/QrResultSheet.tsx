import type { ReactNode } from 'react';
import type { ParsedQr } from '../lib/qr';
import { fmtRub, fmtUsdt } from '../lib/format';
import { Sheet } from './Sheet';

interface Props {
  result: ParsedQr | null;
  walletRate: number | null;
  onClose: () => void;
  onRescan: () => void;
}

const NETWORK_LABEL = { TRC20: 'TRON (TRC-20)', EVM: 'EVM (ERC-20 / BEP-20)', TON: 'TON', SOL: 'Solana' } as const;

export function QrResultSheet({ result, walletRate, onClose, onRescan }: Props) {
  if (!result) return null;

  const usdtFor = (rub?: number) => (rub && walletRate ? fmtUsdt(rub / walletRate) : null);

  let title = 'QR-код';
  let body: ReactNode;
  let primary = 'Продолжить';

  switch (result.kind) {
    case 'sbp':
      title = 'Оплата по QR СБП';
      primary = 'Оплатить';
      body = (
        <>
          <div className="sbp-badge">СБП</div>
          <Row k="Тип QR" v={result.qrType === 'dynamic' ? 'Динамический (сумма от продавца)' : result.qrType === 'static' ? 'Статический (сумма вводится)' : '—'} />
          {result.amountRub !== undefined && <Row k="Сумма" v={fmtRub(result.amountRub)} big />}
          {usdtFor(result.amountRub) && <Row k="Спишется" v={`≈ ${usdtFor(result.amountRub)}`} />}
          <Row k="ID платежа" v={result.id} mono />
        </>
      );
      break;
    case 'invoice':
      title = 'Счёт на оплату';
      primary = 'Оплатить';
      body = (
        <>
          {result.payee && <Row k="Получатель" v={result.payee} />}
          {result.purpose && <Row k="Назначение" v={result.purpose} />}
          {result.amountRub !== undefined && <Row k="Сумма" v={fmtRub(result.amountRub)} big />}
          {usdtFor(result.amountRub) && <Row k="Спишется" v={`≈ ${usdtFor(result.amountRub)}`} />}
        </>
      );
      break;
    case 'crypto':
      title = 'Перевод USDT';
      primary = 'Перевести';
      body = (
        <>
          <Row k="Сеть" v={NETWORK_LABEL[result.network]} />
          <Row k="Адрес" v={result.address} mono />
          {result.amount !== undefined && <Row k="Сумма" v={String(result.amount)} />}
        </>
      );
      break;
    case 'url':
      body = <Row k="Ссылка" v={result.url} mono />;
      break;
    case 'text':
      body = <Row k="Содержимое" v={result.raw} mono />;
      break;
  }

  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="qr-result">{body}</div>
      <div className="sheet-actions">
        <button className="btn ghost" onClick={onRescan}>Сканировать ещё</button>
        <button className="btn primary" disabled title="Скоро">{primary} · скоро</button>
      </div>
    </Sheet>
  );
}

function Row({ k, v, big, mono }: { k: string; v: string; big?: boolean; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="muted">{k}</span>
      <span className={`${big ? 'big' : ''} ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}
