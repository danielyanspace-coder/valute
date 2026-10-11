import { useEffect, useState, type ReactNode } from 'react';
import { SuccessMark } from '../../lib/motion';
import type { FineLookupDto, MeDto, ServiceOrderDto, ServicesConfigDto } from '../../../../shared/api';
import { MIN_PAYOUT_RUB } from '../../../../shared/payout';
import {
  ORDER_STATUS_LABEL,
  SERVICE_TITLE,
  fineDueRub,
  formatParkingPhone,
  normalizeUin,
  rubForServiceMicro,
  serviceMicroForRub,
  validateParkingAmount,
  validateParkingPhone,
  validateSteamLogin,
  validateSteamRub,
  validateUin,
  type FineInfo,
  type ServiceKind,
} from '../../../../shared/services';
import { parseUsdt } from '../../../../shared/transfers';
import gibddLogo from '../../assets/services/gibdd.png';
import parkingLogo from '../../assets/services/parking.png';
import steamLogo from '../../assets/services/steam.png';
import { api } from '../../lib/backend';
import { fmtDateTime, fmtMicro, fmtRub0 } from '../../lib/format';
import { haptic, hapticNotify, openTelegramChat, tg } from '../../lib/telegram';
import { IconAlert, IconCheck, IconChevronRight, IconClock, IconClose } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from '../withdraw/WithdrawFlow';

export const SERVICE_LOGO: Record<ServiceKind, string> = { fine: gibddLogo, parking: parkingLogo, steam: steamLogo };

const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const rubFmt = new Intl.NumberFormat('ru-RU');

interface FlowProps {
  kind: ServiceKind | null;
  onClose: () => void;
  me: MeDto | null;
  onCreated: () => void;
  onOpenOrder: (id: number) => void;
}

/** One sheet for all three services: form → confirm → done. */
export function ServiceFlow({ kind, onClose, me, onCreated, onOpenOrder }: FlowProps) {
  const [config, setConfig] = useState<ServicesConfigDto | null>(null);
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ServiceOrderDto | null>(null);
  const [agreed, setAgreed] = useState(false);

  // fine
  const [uin, setUin] = useState('');
  const [lookup, setLookup] = useState<FineLookupDto | null>(null);
  const [manualRub, setManualRub] = useState('');
  // parking
  const [phone, setPhone] = useState('+7');
  const [parkingRub, setParkingRub] = useState('');
  // steam
  const [login, setLogin] = useState('');
  const [steamUsdt, setSteamUsdt] = useState('');

  useEffect(() => {
    if (!kind) return;
    setStep('form');
    setRequestId(newRequestId());
    setError(null);
    setCreated(null);
    setAgreed(false);
    setUin('');
    setLookup(null);
    setManualRub('');
    setParkingRub('');
    setSteamUsdt('');
    api.servicesConfig().then(setConfig, (e) => setError((e as Error).message));
  }, [kind]);

  if (!kind) return null;
  const rate = config?.serviceRate ?? 0;
  const discount = config?.discountPercent ?? 10;
  const available = me?.availableMicro ?? 0;

  // What this order costs, in rubles and USDT, for the current form state.
  let amountRub = 0;
  let amountMicro = 0;
  let formError: string | null = null;
  let ready = false;

  if (kind === 'fine') {
    const fine = lookup?.found ? lookup.fine : null;
    if (fine) amountRub = fineDueRub(fine);
    else if (lookup && !lookup.found && lookup.manual) amountRub = Number(manualRub) || 0;
    amountMicro = rate && amountRub ? serviceMicroForRub(amountRub, rate) : 0;
    ready = amountRub > 0;
  } else if (kind === 'parking') {
    amountRub = Number(parkingRub) || 0;
    amountMicro = rate && amountRub ? serviceMicroForRub(amountRub, rate) : 0;
    formError = parkingRub ? validateParkingAmount(amountRub) : null;
    ready = !validateParkingPhone(phone) && !validateParkingAmount(amountRub);
  } else {
    const parsed = steamUsdt ? parseUsdt(steamUsdt) : null;
    amountMicro = typeof parsed === 'number' ? parsed : 0;
    amountRub = rate && amountMicro ? rubForServiceMicro(amountMicro, rate) : 0;
    formError = typeof parsed === 'string' ? parsed : amountMicro ? validateSteamRub(amountRub) : null;
    ready = !validateSteamLogin(login) && !!amountMicro && !formError;
  }
  if (amountMicro > available && amountMicro > 0) {
    formError = 'Недостаточно средств';
    ready = false;
  }
  // Rubles saved vs. the exchange price: the discount share of the order.
  const benefitRub = Math.round(amountRub * (discount / 100));

  const findFine = async () => {
    setBusy(true);
    setError(null);
    setLookup(null);
    try {
      setLookup(await api.lookupFine(normalizeUin(uin)));
      haptic();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api.createOrder({
        kind,
        requestId,
        acceptedTerms: true,
        platform: tg?.platform ?? 'web',
        ...(kind === 'fine' ? { uin: normalizeUin(uin), amountRub: lookup?.found ? undefined : amountRub } : {}),
        ...(kind === 'parking' ? { phone, amountRub } : {}),
        ...(kind === 'steam' ? { steamLogin: login.trim(), amountUsdt: steamUsdt } : {}),
      });
      hapticNotify('success');
      setCreated(o);
      setStep('done');
      onCreated();
    } catch (e) {
      hapticNotify('error');
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const price = ready && (
    <PriceBlock amountRub={amountRub} amountMicro={amountMicro} benefitRub={benefitRub} discount={discount} kind={kind} />
  );

  let body: ReactNode;
  if (step === 'done' && created) {
    body = (
      <div className="done">
        <SuccessMark />
        <b>Заявка #{created.id} принята</b>
        <p className="muted">
          {fmtMicro(created.amountMicro)} заморожены. Оператор проведёт оплату и пришлёт уведомление, обычно в течение часа.
        </p>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onClose}>Готово</button>
          <button className="btn primary" onClick={() => onOpenOrder(created.id)}>Открыть заявку</button>
        </div>
      </div>
    );
  } else if (step === 'confirm') {
    body = (
      <div className="form">
        <div className="svc-head"><img src={SERVICE_LOGO[kind]} alt="" /><b>{SERVICE_TITLE[kind]}</b></div>
        {price}
        <div className="kv-list">
          {kind === 'fine' && <Kv k="УИН" v={normalizeUin(uin)} mono />}
          {kind === 'parking' && <Kv k="Телефон аккаунта" v={formatParkingPhone(phone)} />}
          {kind === 'steam' && <Kv k="Логин Steam" v={login.trim()} mono />}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span className="checkbox-box"><IconCheck size={14} /></span>
          <span>
            {kind === 'steam'
              ? 'Это мой аккаунт, логин верный, регион Россия, валюта рубли. Возвратов после пополнения нет'
              : 'Данные проверены. USDT заморозятся до оплаты'}
          </span>
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn primary block" disabled={!agreed || busy} onClick={submit}>
          {busy ? 'Отправляем…' : `Оплатить ${fmtMicro(amountMicro)}`}
        </button>
      </div>
    );
  } else if (kind === 'fine') {
    const fine = lookup?.found ? lookup.fine : null;
    body = (
      <div className="form">
        <ServiceIntro kind={kind} discount={discount} text="Оплатите штраф с баланса USDT на 10% дешевле. Введите УИН, мы найдём штраф и посчитаем сумму." />
        <div className="field">
          <span className="field-label">УИН начисления</span>
          <div className="uin-row">
            <input
              id="fine-uin"
              className="input mono-input"
              inputMode="numeric"
              value={uin}
              onChange={(e) => { setUin(e.target.value.replace(/\D/g, '').slice(0, 25)); setLookup(null); }}
              placeholder="18810177230000123456"
            />
            <button className="btn primary uin-btn" disabled={!!validateUin(uin) || busy} onClick={findFine}>
              {busy ? '…' : 'Найти'}
            </button>
          </div>
          <span className="field-hint">20 или 25 цифр, у штрафов Госавтоинспекции обычно начинается с 188</span>
        </div>
        <Help title="Где найти УИН?">
          <ul>
            <li><b>В постановлении</b> о штрафе: строка «УИН» или «Идентификатор начисления» над QR-кодом.</li>
            <li><b>На Госуслугах:</b> «Штрафы» → откройте штраф → «Идентификатор начисления».</li>
            <li><b>В банковском приложении</b> или в письме, если штраф пришёл туда: в деталях начисления.</li>
            <li>Это 20 или 25 цифр. Номер постановления и УИН у штрафов ГИБДД обычно совпадают.</li>
          </ul>
        </Help>
        {fine && <FineCard fine={fine} />}
        {lookup && !lookup.found && !lookup.manual && <Notice tone="warn">{lookup.message}</Notice>}
        {lookup && !lookup.found && lookup.manual && (
          <div className="field">
            <Notice tone="info">{lookup.message}</Notice>
            <span className="field-label">Сумма штрафа к оплате, ₽</span>
            <div className="input with-suffix amount-input">
              <input inputMode="numeric" value={manualRub ? rubFmt.format(Number(manualRub)) : ''} onChange={(e) => setManualRub(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="0" />
              <span className="suffix">₽</span>
            </div>
            <span className="field-hint">Если действует скидка 50%, укажите сумму со скидкой</span>
          </div>
        )}
        {price}
        {formError && <Notice tone="danger">{formError}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn primary block" disabled={!ready} onClick={() => setStep('confirm')}>Продолжить</button>
      </div>
    );
  } else if (kind === 'parking') {
    body = (
      <div className="form">
        <ServiceIntro kind={kind} discount={discount} text="Пополните парковочный счёт в приложении «Парковки России» с баланса USDT на 10% дешевле." />
        <div className="field">
          <span className="field-label">Телефон, к которому привязан парковочный счёт</span>
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(formatParkingPhone(e.target.value))} placeholder="+7 900 000-00-00" />
          <span className="field-hint">Тот номер, по которому вы входите в «Парковки России»</span>
        </div>
        <div className="field">
          <span className="field-label">Сумма пополнения</span>
          <div className="input with-suffix amount-input">
            <input inputMode="numeric" value={parkingRub ? rubFmt.format(Number(parkingRub)) : ''} onChange={(e) => setParkingRub(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder={`от ${config?.parking.minRub ?? 100}`} />
            <span className="suffix">₽</span>
          </div>
          <div className="chips">
            {[300, 500, 1000, 2000].map((v) => (
              <button key={v} className="chip" onClick={() => setParkingRub(String(v))}>{rubFmt.format(v)} ₽</button>
            ))}
          </div>
        </div>
        {price}
        {formError && <Notice tone="danger">{formError}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn primary block" disabled={!ready} onClick={() => setStep('confirm')}>Продолжить</button>
      </div>
    );
  } else {
    const loginError = login ? validateSteamLogin(login) : null;
    body = (
      <div className="form">
        <ServiceIntro kind={kind} discount={discount} text="Пополните кошелёк Steam с баланса USDT на 10% выгоднее. Деньги придут на аккаунт в рублях." />
        <div className="steam-warning">
          <IconAlert size={18} />
          <p>
            <b>Указывайте именно логин, которым входите в Steam</b>, а не имя профиля. С неверным логином пополнение не пройдёт или
            деньги уйдут другому человеку.
          </p>
        </div>
        <div className={`field ${loginError ? 'has-error' : ''}`}>
          <span className="field-label">Логин Steam</span>
          <input id="steam-login" className="input mono-input" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value.trim())} placeholder="Например, gaben_fan" />
          {loginError && <span className="field-error">{loginError}</span>}
        </div>
        <div className="field">
          <span className="field-label">Сумма</span>
          <div className="input with-suffix amount-input">
            <input id="steam-amount" inputMode="decimal" value={steamUsdt} onChange={(e) => setSteamUsdt(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0" />
            <span className="suffix">USDT</span>
          </div>
          <span className="field-hint">
            От {rubFmt.format(config?.steam.minRub ?? MIN_PAYOUT_RUB)} до {rubFmt.format(config?.steam.maxRub ?? 15000)} ₽ на Steam за один платёж
            {rate ? ` (≈ ${(Math.ceil(((config?.steam.minRub ?? 500) / rate) * 100) / 100).toFixed(2)}–${(Math.floor(((config?.steam.maxRub ?? 15000) / rate) * 100) / 100).toFixed(2)} USDT)` : ''}
          </span>
        </div>
        {price}
        {formError && <Notice tone="danger">{formError}</Notice>}
        <Help title="Обязательно к прочтению" open>
          <ul>
            <li>Валюта аккаунта: <b>рубли</b>. Регион: <b>Россия</b> или другая страна СНГ.</li>
            <li>Сумма от 500 до 15 000 ₽ за один платёж.</li>
            <li>Указывая логин, вы подтверждаете, что пополняете свой аккаунт. После успешного пополнения возврата нет.</li>
          </ul>
        </Help>
        <Help title="Вы в Крыму, ДНР или ЛНР">
          <p>
            Перед оплатой выйдите из Steam и отключите интернет на телефоне, если там установлено приложение Steam. Подождите 15-20
            минут и только потом оплачивайте. Не входите в аккаунт, пока пополнение не пройдёт.
          </p>
        </Help>
        <Help title="Новый аккаунт">
          <p>
            Сначала добавьте несколько бесплатных игр, чтобы закрепить регион, и пополните на минимальную сумму. Иначе Steam может
            сменить регион на СНГ.
          </p>
        </Help>
        <Help title="Где найти логин Steam?">
          <p>Нажмите на свою аватарку → «Об аккаунте». Логин указан в заголовке страницы.</p>
        </Help>
        <Help title="Как проверить регион?">
          <p>В разделе «Об аккаунте» посмотрите страну. Россия или другая страна СНГ подходят, с другим регионом пополнение не пройдёт.</p>
        </Help>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn primary block" disabled={!ready} onClick={() => setStep('confirm')}>Продолжить</button>
      </div>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      onBack={step === 'confirm' ? () => setStep('form') : undefined}
      title={step === 'done' ? '' : step === 'confirm' ? 'Проверьте заявку' : SERVICE_TITLE[kind]}
    >
      {body}
    </Sheet>
  );
}

function ServiceIntro({ kind, discount, text }: { kind: ServiceKind; discount: number; text: string }) {
  return (
    <div className="svc-intro">
      <span className="svc-logo">
        <span className={`svc-logo-inner svc-bg-${kind}`}><img src={SERVICE_LOGO[kind]} alt="" /></span>
        <span className="svc-discount">−{discount}%</span>
      </span>
      <p>{text}</p>
    </div>
  );
}

function PriceBlock({ amountRub, amountMicro, benefitRub, discount, kind }: { amountRub: number; amountMicro: number; benefitRub: number; discount: number; kind: ServiceKind }) {
  return (
    <div className="price-block">
      <div className="price-row">
        <span className="muted">{kind === 'steam' ? 'Поступит на Steam' : 'Сумма'}</span>
        <b>{fmtRub0(amountRub)}</b>
      </div>
      <div className="price-row main">
        <span>Спишется с баланса</span>
        <b>{fmtMicro(amountMicro)}</b>
      </div>
      <div className="price-benefit">
        <span>Ваша выгода</span>
        <b>{fmtRub0(benefitRub)} · −{discount}%</b>
      </div>
    </div>
  );
}

function FineCard({ fine }: { fine: FineInfo }) {
  const discountActive = fine.discountedAmountRub !== null && (fine.discountUntil ?? 0) > Date.now();
  return (
    <div className="fine-card">
      <div className="fine-top">
        <img src={gibddLogo} alt="" />
        <div>
          <b>{fine.description ?? 'Штраф Госавтоинспекции'}</b>
          {fine.article && <span className="muted">{fine.article}</span>}
        </div>
      </div>
      <div className="kv-list">
        {fine.issuedAt && <Kv k="Дата постановления" v={new Date(fine.issuedAt).toLocaleDateString('ru-RU')} />}
        <Kv k="Сумма штрафа" v={fmtRub0(fine.amountRub)} strike={discountActive} />
        {discountActive && (
          <Kv k={`Со скидкой 50% до ${new Date(fine.discountUntil!).toLocaleDateString('ru-RU')}`} v={fmtRub0(fine.discountedAmountRub!)} accent />
        )}
      </div>
    </div>
  );
}

function Help({ title, children, open: initial = false }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`help ${open ? 'open' : ''}`}>
      <button className="help-q" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        <IconChevronRight size={15} className="faq-chevron" />
      </button>
      {open && <div className="help-a">{children}</div>}
    </div>
  );
}

function Kv({ k, v, mono, strike, accent }: { k: string; v: string; mono?: boolean; strike?: boolean; accent?: boolean }) {
  return (
    <div className="kv">
      <span className="muted">{k}</span>
      <span className={`${mono ? 'mono' : ''} ${strike ? 'strike' : ''} ${accent ? 'up' : ''}`}>{v}</span>
    </div>
  );
}

// ---------- Order status ----------

export function OrderSheet({ id, onClose, supportUsername }: { id: number | null; onClose: () => void; supportUsername: string }) {
  const [o, setO] = useState<ServiceOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return;
    setO(null);
    setError(null);
    let alive = true;
    const load = () => api.order(id).then((x) => alive && setO(x), (e) => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  return (
    <Sheet open={id !== null} onClose={onClose} title={o ? `Заявка #${o.id}` : 'Заявка'}>
      {!o && !error && <div className="skeleton" style={{ height: 160 }} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {o && (
        <div className="wd">
          <div className={`wd-status o-${o.status}`}>
            <span className="wd-status-icon">
              {o.status === 'paid' ? <IconCheck size={18} /> : o.status === 'rejected' ? <IconClose size={16} /> : o.status === 'clarify' ? <IconAlert size={16} /> : <IconClock size={18} />}
            </span>
            {ORDER_STATUS_LABEL[o.status]}
          </div>
          <div className="svc-head center"><img src={SERVICE_LOGO[o.kind]} alt="" /><b>{SERVICE_TITLE[o.kind]}</b></div>
          <div className="wd-amount">{fmtRub0(o.amountRub)}</div>
          <div className="muted wd-dest">{o.target}</div>
          {o.status === 'pending' && <Notice tone="info">Оператор проводит оплату. Мы пришлём уведомление, когда всё будет готово.</Notice>}
          {o.status === 'clarify' && (
            <div className="dispute-box">
              <b>Нужно уточнение</b>
              <p>{o.clarifyMessage}</p>
              {supportUsername && <button className="btn primary block" onClick={() => openTelegramChat(supportUsername)}>Ответить в поддержку</button>}
            </div>
          )}
          {o.status === 'rejected' && <Notice tone="danger">Заявка отклонена{o.rejectReason ? `: ${o.rejectReason}` : ''}. {fmtMicro(o.amountMicro)} вернулись на баланс.</Notice>}
          {o.status === 'paid' && <Notice tone="info">Оплачено {o.finishedAt ? fmtDateTime(o.finishedAt) : ''}.</Notice>}
          <div className="kv-list">
            <Kv k="Списание" v={fmtMicro(o.amountMicro)} />
            <Kv k="Выгода" v={`${fmtRub0(o.benefitRub)} · −${o.discountPercent}%`} accent />
            <Kv k="Создана" v={fmtDateTime(o.createdAt)} />
          </div>
        </div>
      )}
    </Sheet>
  );
}
