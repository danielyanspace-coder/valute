import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SuccessMark } from '../../lib/motion';
import type { MeDto, UsdtPayoutDto, WithdrawalDto } from '../../../../shared/api';
import { parseUsdt, shortUsdt } from '../../../../shared/transfers';
import { maxUsdtPayoutMicro, validateUsdtPayout } from '../../../../shared/usdtPayout';
import {
  CARD_BRAND_LABEL,
  MIN_PAYOUT_RUB,
  cardBrand,
  formatCard,
  formatRuPhone,
  maxPayoutRub,
  normalizeRuPhone,
  usdtMicroForRub,
  validateCard,
  validatePayoutRub,
  validateRuPhone,
} from '../../../../shared/payout';
import { findBank } from '../../../../shared/sbpBanks';
import type { WalletRate } from '../../lib/api';
import { api } from '../../lib/backend';
import { fmtMicro, fmtRub, fmtRub0 } from '../../lib/format';
import { canUseNativeQr, haptic, hapticNotify, tg } from '../../lib/telegram';
import { IconAlert, IconChat, IconCheck, IconChevronRight, IconClock, IconQr } from '../icons';
import { Sheet } from '../Sheet';
import { CoinIcon } from '../CoinIcon';
import { MirMark, SbpMark, SbpMirMark } from '../brandMarks';
import { BankAvatar, BankPicker } from './BankPicker';

type Step = 'choose' | 'crypto' | 'crypto-terms' | 'crypto-done' | 'card-method' | 'sbp' | 'bank' | 'card' | 'terms' | 'done';

const BACK: Partial<Record<Step, Step>> = {
  crypto: 'choose',
  'crypto-terms': 'crypto',
  'card-method': 'choose',
  sbp: 'card-method',
  card: 'card-method',
  bank: 'sbp',
};

const TITLE: Record<Step, string> = {
  choose: 'Вывести',
  crypto: 'Вывод USDT',
  'crypto-terms': 'Проверьте перевод',
  'crypto-done': '',
  'card-method': 'На банковскую карту',
  sbp: 'Перевод по СБП',
  bank: 'Банк получателя',
  card: 'Перевод на карту',
  terms: 'Перед выводом',
  done: '',
};

interface Props {
  open: boolean;
  onClose: () => void;
  me: MeDto | null;
  rate: WalletRate | null;
  /** A request was created: refresh balances and history. */
  onCreated: (w: WithdrawalDto | null) => void;
  onOpenWithdrawal: (id: number) => void;
  onOpenUsdtPayout: (id: number) => void;
}

const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
/** "tron:T...?amount=1" and similar wallet QR payloads → the bare address. */
const cleanAddress = (s: string) => s.trim().replace(/^tron:/i, '').replace(/[?#].*$/, '').trim();

const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function WithdrawFlow({ open, onClose, me, rate, onCreated, onOpenWithdrawal, onOpenUsdtPayout }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [method, setMethod] = useState<'sbp' | 'card'>('sbp');
  const [phone, setPhone] = useState('+7');
  const [bankId, setBankId] = useState<string | null>(null);
  const [card, setCard] = useState('');
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<WithdrawalDto | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const [address, setAddress] = useState('');
  const [usdt, setUsdt] = useState('');
  const [usdtCreated, setUsdtCreated] = useState<UsdtPayoutDto | null>(null);

  // Every opening starts a fresh flow; the request id protects against double submits within it.
  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setAmount('');
    setTouched(false);
    setAgreed(false);
    setServerError(null);
    setCreated(null);
    setRequestId(newRequestId());
    setAddress('');
    setUsdt('');
    setUsdtCreated(null);
  }, [open]);

  const payoutRate = rate?.walletRate ?? 0;
  const available = me?.availableMicro ?? 0;
  const maxRub = payoutRate ? maxPayoutRub(available, payoutRate) : 0;
  const amountRub = Number(amount) || 0;
  const amountMicro = payoutRate && amountRub ? usdtMicroForRub(amountRub, payoutRate) : 0;
  const bank = bankId ? findBank(bankId) : undefined;

  const amountError = amount ? validatePayoutRub(amountRub, maxRub) : touched ? 'Введите сумму' : null;
  const phoneError = validateRuPhone(phone);
  const cardError = validateCard(card);
  const destinationOk = method === 'sbp' ? !phoneError && !!bank : !cardError;
  const canContinue = destinationOk && !validatePayoutRub(amountRub, maxRub) && !!payoutRate;

  const go = (s: Step) => {
    haptic();
    setServerError(null);
    setStep(s);
  };

  const back = step === 'terms' ? () => go(method) : BACK[step] ? () => go(BACK[step]!) : undefined;

  // ---------- USDT TRC-20 ----------
  const feeMicro = me?.usdtPayout.feeMicro ?? 0;
  const minMicro = me?.usdtPayout.minMicro ?? 0;
  const parsedUsdt = usdt ? parseUsdt(usdt) : null;
  const usdtMicro = typeof parsedUsdt === 'number' ? parsedUsdt : 0;
  const usdtError = typeof parsedUsdt === 'string' ? parsedUsdt : usdtMicro ? validateUsdtPayout(usdtMicro, available, feeMicro, minMicro) : null;
  const addressError = address && !TRON_RE.test(address) ? 'Адрес TRON начинается на T и состоит из 34 символов' : null;
  const canUsdt = TRON_RE.test(address) && usdtMicro > 0 && !usdtError;
  const maxUsdt = maxUsdtPayoutMicro(available, feeMicro);

  const scanAddress = () => {
    haptic();
    tg!.showScanQrPopup({ text: 'QR-код адреса USDT TRC-20' }, (text) => {
      setAddress(cleanAddress(text));
      return true;
    });
  };
  const pasteAddress = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setAddress(cleanAddress(text));
    } catch {
      /* clipboard not allowed: the user pastes by hand */
    }
  };

  const submitUsdt = async () => {
    setSubmitting(true);
    setServerError(null);
    try {
      const p = await api.createUsdtPayout({ address, amount: usdt, requestId, acceptedTerms: true });
      hapticNotify('success');
      setUsdtCreated(p);
      setStep('crypto-done');
      onCreated(null);
    } catch (e) {
      hapticNotify('error');
      setServerError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setServerError(null);
    try {
      const w = await api.createWithdrawal({
        method,
        amountRub,
        phone: method === 'sbp' ? normalizeRuPhone(phone) : undefined,
        bankId: method === 'sbp' ? bankId! : undefined,
        cardNumber: method === 'card' ? card.replace(/\D/g, '') : undefined,
        requestId,
        platform: tg?.platform ?? 'web',
        acceptedTerms: true,
      });
      hapticNotify('success');
      setCreated(w);
      setStep('done');
      onCreated(w);
    } catch (e) {
      hapticNotify('error');
      setServerError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const destinationText = method === 'sbp' ? `${formatRuPhone(phone)} · ${bank?.name ?? ''}` : formatCard(card);

  let body: ReactNode;
  switch (step) {
    case 'choose':
      body = (
        <div className="option-list">
          {me?.blocked && <Notice tone="danger">Вывод временно недоступен. Напишите в поддержку, мы поможем.</Notice>}
          <Option
            icon={<SbpMirMark />}
            iconTone="plain"
            title="На банковскую карту"
            subtitle="Рубли по СБП или номеру карты"
            disabled={me?.blocked}
            onClick={() => go('card-method')}
          />
          <Option
            icon={<CoinIcon symbol="USDT" size={40} />}
            iconTone="plain"
            title="На криптокошелёк"
            subtitle={`USDT в сети TRON (TRC-20)${feeMicro ? `, комиссия ${shortUsdt(feeMicro)} USDT` : ''}`}
            disabled={me?.blocked}
            onClick={() => go('crypto')}
          />
        </div>
      );
      break;

    case 'crypto':
      body = (
        <div className="form">
          <Field label="Адрес получателя, сеть TRON (TRC-20)" error={addressError}>
            <div className="input with-suffix addr-input">
              <input
                value={address}
                onChange={(e) => setAddress(cleanAddress(e.target.value))}
                placeholder="T..."
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {canUseNativeQr() ? (
                <button className="addr-btn" onClick={scanAddress} aria-label="Сканировать QR"><IconQr size={18} /></button>
              ) : (
                <button className="addr-btn text" onClick={pasteAddress}>Вставить</button>
              )}
            </div>
          </Field>
          <Field label="Сумма к получению" error={usdtError}>
            <div className="input with-suffix amount-input">
              <input inputMode="decimal" value={usdt} onChange={(e) => setUsdt(e.target.value.replace(/[^\d.,]/g, '').slice(0, 12))} placeholder={`от ${shortUsdt(minMicro)}`} />
              <span className="suffix">USDT</span>
            </div>
            <div className="chips">
              {maxUsdt >= minMicro && <button className="chip" onClick={() => setUsdt(shortUsdt(maxUsdt))}>Всё: {shortUsdt(maxUsdt)} USDT</button>}
            </div>
          </Field>
          <div className="kv-list usdt-calc">
            <div className="kv"><span className="muted">Получатель получит</span><span>{shortUsdt(usdtMicro)} USDT</span></div>
            <div className="kv"><span className="muted">Комиссия сети</span><span>{shortUsdt(feeMicro)} USDT</span></div>
            <div className="kv total"><span>Спишется с баланса</span><b>{shortUsdt(usdtMicro ? usdtMicro + feeMicro : 0)} USDT</b></div>
          </div>
          <span className="field-hint">Доступно {fmtMicro(available)}. Минимум {shortUsdt(minMicro)} USDT.</span>
          <button className="btn primary block" disabled={!canUsdt} onClick={() => go('crypto-terms')}>Продолжить</button>
        </div>
      );
      break;

    case 'crypto-terms':
      body = (
        <div className="form">
          <div className="summary usdt-summary">
            <CoinIcon symbol="USDT" size={44} />
            <div className="summary-amount">{shortUsdt(usdtMicro)} USDT</div>
            <div className="usdt-address">
              <span className="hl">{address.slice(0, 6)}</span>{address.slice(6, -6)}<span className="hl">{address.slice(-6)}</span>
            </div>
            <div className="summary-freeze">Сеть TRON (TRC-20) · спишется {shortUsdt(usdtMicro + feeMicro)} USDT с комиссией</div>
          </div>
          <div className="rules">
            <Rule icon={<IconAlert size={18} />} title="Только сеть TRON (TRC-20)" tone="warn">
              Убедитесь, что кошелёк или биржа принимает USDT именно в сети TRC-20. Перевод на адрес другой сети будет потерян, вернуть его не получится.
            </Rule>
            <Rule icon={<IconClock size={18} />} title="Отправляем вручную">
              Обычно в течение часа. Как только USDT уйдут, пришлём уведомление с хэшем транзакции.
            </Rule>
            <Rule icon={<IconChat size={18} />} title="Заявку нельзя изменить">
              Проверьте первые и последние символы адреса. Если ошиблись, сразу напишите в поддержку, пока перевод не отправлен.
            </Rule>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span className="checkbox-box"><IconCheck size={14} /></span>
            <span>Адрес проверил, сеть TRC-20</span>
          </label>
          {serverError && <Notice tone="danger">{serverError}</Notice>}
          <button className="btn primary block" disabled={!agreed || submitting} onClick={submitUsdt}>
            {submitting ? 'Отправляем заявку…' : `Вывести ${shortUsdt(usdtMicro)} USDT`}
          </button>
        </div>
      );
      break;

    case 'crypto-done':
      body = usdtCreated && (
        <div className="done">
          <SuccessMark />
          <b>Заявка принята</b>
          <p className="muted">
            {shortUsdt(usdtCreated.amountMicro)} USDT на {usdtCreated.address.slice(0, 6)}…{usdtCreated.address.slice(-6)}. Отправим вручную и пришлём
            уведомление с хэшем транзакции.
          </p>
          <div className="done-freeze">{shortUsdt(usdtCreated.totalMicro)} USDT заморожены до отправки</div>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={onClose}>Готово</button>
            <button className="btn primary" onClick={() => onOpenUsdtPayout(usdtCreated.id)}>Открыть заявку</button>
          </div>
        </div>
      );
      break;

    case 'card-method':
      body = (
        <div className="option-list">
          <Option
            icon={<SbpMark size={24} />}
            iconTone="light"
            title="По СБП"
            subtitle="По номеру телефона в любой банк"
            onClick={() => {
              setMethod('sbp');
              go('sbp');
            }}
          />
          <Option
            icon={<MirMark width={32} />}
            iconTone="light"
            title="По номеру карты"
            subtitle="МИР, Visa, Mastercard российских банков"
            onClick={() => {
              setMethod('card');
              go('card');
            }}
          />
        </div>
      );
      break;

    case 'sbp':
      body = (
        <div className="form">
          <Field label="Номер телефона получателя" error={phoneHint(phone, phoneError)}>
            <input
              className="input"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(formatRuPhone(e.target.value))}
              placeholder="+7 900 000-00-00"
            />
          </Field>
          <Field label="Банк получателя">
            <button className="input select" onClick={() => go('bank')}>
              {bank ? (
                <>
                  <BankAvatar bank={bank} size={26} />
                  <span className="select-value">{bank.name}</span>
                </>
              ) : (
                <span className="select-placeholder">Выберите банк</span>
              )}
              <IconChevronRight size={16} className="select-chevron" />
            </button>
          </Field>
          <AmountField
            amount={amount}
            setAmount={setAmount}
            onBlur={() => setTouched(true)}
            error={amountError}
            maxRub={maxRub}
            amountMicro={amountMicro}
            payoutRate={payoutRate}
          />
          <button className="btn primary block" disabled={!canContinue} onClick={() => go('terms')}>
            Вывести
          </button>
        </div>
      );
      break;

    case 'bank':
      body = (
        <BankPicker
          selectedId={bankId}
          onSelect={(id) => {
            setBankId(id);
            go('sbp');
          }}
        />
      );
      break;

    case 'card': {
      const digits = card.replace(/\D/g, '');
      const brand = CARD_BRAND_LABEL[cardBrand(digits)];
      body = (
        <div className="form">
          <Field label="Номер карты получателя" error={digits.length >= 16 ? cardError : null}>
            <div className="input with-suffix">
              <input
                inputMode="numeric"
                autoComplete="cc-number"
                value={card}
                onChange={(e) => setCard(formatCard(e.target.value))}
                placeholder="0000 0000 0000 0000"
              />
              {brand && digits.length >= 4 && <span className="card-brand">{brand}</span>}
            </div>
          </Field>
          <AmountField
            amount={amount}
            setAmount={setAmount}
            onBlur={() => setTouched(true)}
            error={amountError}
            maxRub={maxRub}
            amountMicro={amountMicro}
            payoutRate={payoutRate}
          />
          <button className="btn primary block" disabled={!canContinue} onClick={() => go('terms')}>
            Вывести
          </button>
        </div>
      );
      break;
    }

    case 'terms':
      body = (
        <div className="form">
          <div className="summary">
            <div className="summary-amount">{fmtRub0(amountRub)}</div>
            <div className="muted">{destinationText}</div>
            <div className="summary-freeze">Заморозится {fmtMicro(amountMicro)} по курсу {fmtRub(payoutRate)}</div>
          </div>
          <div className="rules">
            <Rule icon={<IconClock size={18} />} title="Подтвердите получение">
              Когда деньги начнут путь, придёт уведомление в боте. Проверьте счёт и нажмите «Подтвердить получение».
              Чем быстрее вы подтверждаете, тем выше ваш рейтинг и тем выгоднее курс для вас.
            </Rule>
            <Rule icon={<IconChat size={18} />} title="Пришла другая сумма или деньги не пришли?">
              Сообщите об этом в заявке, мы проверим платёж. Заявку после создания отменить нельзя.
            </Rule>
            <Rule icon={<IconAlert size={18} />} title="Не пропускайте уведомления" tone="warn">
              Если не ответить на 5 уведомлений, сделка уйдёт на рассмотрение администратора, а кошелёк будет
              приостановлен, пока вы не ответите по заявке.
            </Rule>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span className="checkbox-box"><IconCheck size={14} /></span>
            <span>Понимаю и согласен с условиями вывода</span>
          </label>
          {serverError && <Notice tone="danger">{serverError}</Notice>}
          <button className="btn primary block" disabled={!agreed || submitting} onClick={submit}>
            {submitting ? 'Отправляем заявку…' : `Вывести ${fmtRub0(amountRub)}`}
          </button>
        </div>
      );
      break;

    case 'done':
      body = created && (
        <div className="done">
          <SuccessMark />
          <b>Заявка принята</b>
          <p className="muted">
            {fmtRub0(created.amountRub)} на {created.destination}. Мы пришлём уведомление, когда деньги начнут путь.
          </p>
          <div className="done-freeze">{fmtMicro(created.amountMicro)} заморожены до завершения вывода</div>
          <Notice tone="warn">
            <b>Будьте внимательны.</b> Когда деньги начнут путь, бот пришлёт уведомления по этой заявке. Проверьте счёт и ответьте на них.
            Если не ответить, кошелёк будет приостановлен до вашего ответа.
          </Notice>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={onClose}>Готово</button>
            <button className="btn primary" onClick={() => onOpenWithdrawal(created.id)}>Открыть заявку</button>
          </div>
        </div>
      );
      break;
  }

  return (
    <Sheet open={open} onClose={onClose} onBack={back} title={TITLE[step]} tall={step === 'bank'}>
      {body}
    </Sheet>
  );
}

/** Show the phone error once it is certain: a non-mobile prefix right away, length only when typed in full. */
function phoneHint(phone: string, error: string | null): string | null {
  const d = phone.replace(/\D/g, '');
  if (d.length >= 2 && d[1] !== '9') return error;
  return d.length >= 11 ? error : null;
}

function Option(props: { icon: ReactNode; iconTone?: 'light' | 'plain'; title: string; subtitle: string; badge?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="option" onClick={props.onClick} disabled={props.disabled}>
      <span className={`option-icon ${props.iconTone ?? ''}`}>{props.icon}</span>
      <span className="option-text">
        <b>{props.title}</b>
        <span className="muted">{props.subtitle}</span>
      </span>
      {props.badge ? <span className="pill">{props.badge}</span> : <IconChevronRight size={16} className="muted" />}
    </button>
  );
}

function Field({ label, error, children }: { label: string; error?: string | null; children: ReactNode }) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

const rub = new Intl.NumberFormat('ru-RU');

function AmountField(props: {
  amount: string;
  setAmount: (v: string) => void;
  onBlur: () => void;
  error: string | null;
  maxRub: number;
  amountMicro: number;
  payoutRate: number;
}) {
  const { amount, setAmount, maxRub } = props;
  const presets = useMemo(() => [5000, 10000, 50000].filter((v) => v <= maxRub), [maxRub]);
  return (
    <Field label="Сумма" error={props.error}>
      <div className="input with-suffix amount-input">
        <input
          inputMode="numeric"
          value={amount ? rub.format(Number(amount)) : ''}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 9))}
          onBlur={props.onBlur}
          placeholder={`от ${rub.format(MIN_PAYOUT_RUB)}`}
        />
        <span className="suffix">₽</span>
      </div>
      <div className="chips">
        {presets.map((v) => (
          <button key={v} className="chip" onClick={() => setAmount(String(v))}>{rub.format(v)} ₽</button>
        ))}
        {maxRub >= MIN_PAYOUT_RUB && (
          <button className="chip" onClick={() => setAmount(String(maxRub))}>Всё: {rub.format(maxRub)} ₽</button>
        )}
      </div>
      <div className="amount-meta">
        <span>Доступно {fmtRub0(maxRub)}</span>
        <span>{props.amountMicro ? `Заморозится ${fmtMicro(props.amountMicro)}` : props.payoutRate ? `1 USDT = ${fmtRub(props.payoutRate)}` : ''}</span>
      </div>
      <span className="field-hint">Сумма кратна 1000 ₽, минимум {rub.format(MIN_PAYOUT_RUB)} ₽</span>
    </Field>
  );
}

function Rule({ icon, title, tone, children }: { icon: ReactNode; title: string; tone?: 'warn'; children: ReactNode }) {
  return (
    <div className={`rule ${tone ?? ''}`}>
      <span className="rule-icon">{icon}</span>
      <div>
        <b>{title}</b>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'danger' | 'warn' | 'info'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}
