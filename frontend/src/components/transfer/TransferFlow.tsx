import { useEffect, useState, type ReactNode } from 'react';
import type { CheckDto, MeDto, PersonDto, TransferDto } from '../../../../shared/api';
import { USDT_MICRO } from '../../../../shared/payout';
import { MAX_COMMENT_LENGTH, normalizeUsername, parseUsdt, shortUsdt } from '../../../../shared/transfers';
import { IS_DEMO } from '../../lib/api';
import { api } from '../../lib/backend';
import { fmtDateTime, fmtMicro } from '../../lib/format';
import { copyText, haptic, hapticNotify, shareInline } from '../../lib/telegram';
import { IconCheck, IconChevronRight, IconCopy, IconUser } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from '../withdraw/WithdrawFlow';
import { CheckCard } from './CheckCard';

type Step = 'choose' | 'username' | 'sent' | 'check' | 'check-ready' | 'my-checks';

const TITLE: Record<Step, string> = {
  choose: 'Перевести',
  username: 'По username',
  sent: '',
  check: 'Новый чек',
  'check-ready': 'Чек создан',
  'my-checks': 'Мои чеки',
};

const BACK: Partial<Record<Step, Step>> = { username: 'choose', check: 'choose', 'my-checks': 'choose', 'check-ready': 'my-checks' };

const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

interface Props {
  open: boolean;
  onClose: () => void;
  me: MeDto | null;
  onChanged: () => void;
}

export function TransferFlow({ open, onClose, me, onChanged }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [username, setUsername] = useState('');
  const [recipient, setRecipient] = useState<PersonDto | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<TransferDto | null>(null);
  const [check, setCheck] = useState<CheckDto | null>(null);
  const [checks, setChecks] = useState<CheckDto[]>([]);
  const [requestId, setRequestId] = useState(newRequestId);

  const bot = me?.botUsername || 'bot';
  const available = me?.availableMicro ?? 0;

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setUsername('');
    setRecipient(null);
    setAmount('');
    setComment('');
    setError(null);
    setRequestId(newRequestId());
    api.checks().then((r) => setChecks(r.items), () => {});
  }, [open]);

  // Look the recipient up while typing, so the user sees who gets the money before sending.
  useEffect(() => {
    setRecipient(null);
    setLookupError(null);
    const name = normalizeUsername(username);
    if (name.length < 4) return;
    const t = setTimeout(() => {
      api.lookupUser(name).then(setRecipient, (e) => setLookupError((e as Error).message));
    }, 400);
    return () => clearTimeout(t);
  }, [username]);

  const parsed = amount ? parseUsdt(amount) : null;
  const amountMicro = typeof parsed === 'number' ? parsed : 0;
  const amountError = typeof parsed === 'string' ? parsed : amountMicro > available ? 'Недостаточно средств' : null;

  const go = (s: Step) => {
    haptic();
    setError(null);
    setStep(s);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      hapticNotify('success');
      onChanged();
    } catch (e) {
      hapticNotify('error');
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    run(async () => {
      setSent(await api.sendTransfer({ username: normalizeUsername(username), amount, comment, requestId }));
      setStep('sent');
    });

  const createCheck = () =>
    run(async () => {
      const c = await api.createCheck({ amount, comment, requestId });
      setCheck(c);
      setChecks((list) => [c, ...list]);
      setStep('check-ready');
    });

  const activeChecks = checks.filter((c) => c.status === 'active');

  let body: ReactNode;
  switch (step) {
    case 'choose':
      body = (
        <div className="option-list">
          {me?.blocked && <Notice tone="danger">Операции временно недоступны. Напишите в поддержку.</Notice>}
          <Option icon={<IconUser size={20} />} title="По username" subtitle="Мгновенно и без комиссии" onClick={() => go('username')} />
          <Option icon={<span className="check-mini">ЧЕК</span>} title="Создать чек" subtitle="Ссылка, которую можно переслать кому угодно" onClick={() => go('check')} />
          <Option
            icon={<span className="option-count">{activeChecks.length}</span>}
            title="Мои чеки"
            subtitle={activeChecks.length ? `Активных: ${activeChecks.length}` : 'Созданные чеки и их статус'}
            onClick={() => go('my-checks')}
          />
          <BotHint bot={bot} />
        </div>
      );
      break;

    case 'username':
      body = (
        <div className="form">
          <div className="field">
            <span className="field-label">Username получателя в Telegram</span>
            <div className="input with-suffix">
              <span className="suffix">@</span>
              <input
                id="transfer-username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={username.replace(/^@/, '')}
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                placeholder="username"
              />
            </div>
            {recipient && (
              <div className="recipient">
                <span className="recipient-avatar">{recipient.firstName.slice(0, 1).toUpperCase()}</span>
                <span className="recipient-name">
                  <b>{recipient.firstName}</b>
                  <span className="muted">@{recipient.username}</span>
                </span>
                <IconCheck size={18} className="recipient-ok" />
              </div>
            )}
            {lookupError && <span className="field-error">{lookupError}</span>}
          </div>
          <AmountUsdt amount={amount} setAmount={setAmount} error={amountError} available={available} />
          <CommentField comment={comment} setComment={setComment} />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn primary block" disabled={!recipient || !amountMicro || !!amountError || busy} onClick={send}>
            {busy ? 'Переводим…' : recipient && amountMicro ? `Перевести ${shortUsdt(amountMicro)} USDT @${recipient.username}` : 'Перевести'}
          </button>
          <p className="muted small center">Получатель должен хотя бы раз открыть кошелёк. Если его нет, создайте чек.</p>
        </div>
      );
      break;

    case 'sent':
      body = sent && (
        <div className="done">
          <span className="done-icon"><IconCheck size={30} /></span>
          <b>Отправлено {shortUsdt(sent.amountMicro)} USDT</b>
          <p className="muted">
            {sent.counterparty.firstName}
            {sent.counterparty.username ? ` (@${sent.counterparty.username})` : ''} уже получил перевод и уведомление.
          </p>
          <div className="sheet-actions">
            <button className="btn primary" onClick={onClose}>Готово</button>
          </div>
        </div>
      );
      break;

    case 'check':
      body = (
        <div className="form">
          <AmountUsdt amount={amount} setAmount={setAmount} error={amountError} available={available} />
          <CommentField comment={comment} setComment={setComment} />
          <div className="check-preview"><CheckCard amountMicro={amountMicro || USDT_MICRO} dim={!amountMicro} /></div>
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn primary block" disabled={!amountMicro || !!amountError || busy} onClick={createCheck}>
            {busy ? 'Создаём…' : amountMicro ? `Создать чек на ${shortUsdt(amountMicro)} USDT` : 'Создать чек'}
          </button>
          <p className="muted small center">Сумма замораживается до активации. Неактивированный чек можно отменить.</p>
        </div>
      );
      break;

    case 'check-ready':
      body = check && <CheckReady check={check} bot={bot} onChanged={(c) => { setCheck(c); setChecks((l) => l.map((x) => (x.id === c.id ? c : x))); onChanged(); }} />;
      break;

    case 'my-checks':
      body = (
        <div className="checks-list">
          {checks.length === 0 && <div className="empty">Чеков пока нет</div>}
          {checks.map((c) => (
            <button key={c.id} className="check-row" onClick={() => { setCheck(c); go('check-ready'); }}>
              <span className={`check-dot s-${c.status}`} />
              <span className="check-row-main">
                <b>{shortUsdt(c.amountMicro)} USDT</b>
                <span className="muted">{c.comment ?? fmtDateTime(c.createdAt)}</span>
              </span>
              <span className={`status-chip c-${c.status}`}>{CHECK_STATUS[c.status]}</span>
              <IconChevronRight size={15} className="muted" />
            </button>
          ))}
        </div>
      );
      break;
  }

  return (
    <Sheet open={open} onClose={onClose} onBack={BACK[step] ? () => go(BACK[step]!) : undefined} title={TITLE[step]}>
      {body}
    </Sheet>
  );
}

const CHECK_STATUS = { active: 'Активен', claimed: 'Активирован', cancelled: 'Отменён' } as const;

function CheckReady({ check, bot, onChanged }: { check: CheckDto; bot: string; onChanged: (c: CheckDto) => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [demoNote, setDemoNote] = useState<string | null>(null);

  const share = async () => {
    haptic();
    if (shareInline(`c_${check.code}`)) return;
    // Outside Telegram (or the demo): copy the link instead.
    setCopied(await copyText(check.link));
    setDemoNote(IS_DEMO ? 'В Telegram откроется выбор чата, и чек отправится сообщением с кнопкой «Получить».' : null);
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.cancelCheck(check.id));
      hapticNotify('success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  };

  const demoClaim = async () => {
    await api.demoClaimCheck?.(check.code);
    onChanged({ ...check, status: 'claimed', claimedAt: Date.now(), claimedBy: { username: 'masha_k', firstName: 'Маша' } });
  };

  return (
    <div className="form">
      <CheckCard amountMicro={check.amountMicro} dim={check.status !== 'active'} />
      {check.comment && <p className="check-comment">«{check.comment}»</p>}

      {check.status === 'active' && (
        <>
          <button className="btn primary block" onClick={share}>Отправить в чат</button>
          <button className="btn ghost block copy-btn" onClick={async () => setCopied(await copyText(check.link))}>
            <IconCopy size={16} /> {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}
          </button>
          {demoNote && <Notice tone="info">{demoNote}</Notice>}
          <div className="link-box">{check.link}</div>
          <p className="muted small center">Кто первым нажмёт «Получить», тот и получит USDT. Не публикуйте ссылку в открытых чатах.</p>
          {IS_DEMO && (
            <div className="demo-chat">
              <span className="demo-chat-label">Так чек выглядит в чате</span>
              <div className="demo-bubble">
                <span className="demo-via">через @{bot}</span>
                <CheckCard amountMicro={check.amountMicro} />
                <span className="demo-caption">Чек на {shortUsdt(check.amountMicro)} USDT.</span>
              </div>
              <button className="demo-claim" onClick={demoClaim}>Получить {shortUsdt(check.amountMicro)} USDT</button>
              <span className="demo-chat-label">Нажмите, чтобы представить, что друг @masha_k получил чек</span>
            </div>
          )}
          {!confirmCancel ? (
            <button className="link-danger" onClick={() => setConfirmCancel(true)}>Отменить чек</button>
          ) : (
            <div className="ask">
              <p>Отменить чек? {fmtMicro(check.amountMicro)} вернутся на баланс, ссылка перестанет работать.</p>
              <div className="sheet-actions">
                <button className="btn ghost" onClick={() => setConfirmCancel(false)}>Нет</button>
                <button className="btn danger" disabled={busy} onClick={cancel}>Отменить</button>
              </div>
            </div>
          )}
        </>
      )}
      {check.status === 'claimed' && (
        <Notice tone="info">
          Активирован {check.claimedBy ? (check.claimedBy.username ? `@${check.claimedBy.username}` : check.claimedBy.firstName) : ''}
          {check.claimedAt ? `, ${fmtDateTime(check.claimedAt)}` : ''}.
        </Notice>
      )}
      {check.status === 'cancelled' && <Notice tone="warn">Чек отменён, средства вернулись на баланс.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function BotHint({ bot }: { bot: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bot-hint">
      <b>Быстрее через бота</b>
      <p>В любом чате напишите команду и сумму, затем выберите «Отправить чек». Получатель нажмёт «Получить».</p>
      <button className="bot-command" onClick={async () => setCopied(await copyText(`@${bot} `))}>
        <span>@{bot} <i>10</i></span>
        <span className="muted small">{copied ? 'Скопировано' : 'Скопировать'}</span>
      </button>
      <p className="muted small">Можно с комментарием: @{bot} 10 за кофе</p>
    </div>
  );
}

function AmountUsdt({ amount, setAmount, error, available }: { amount: string; setAmount: (v: string) => void; error: string | null; available: number }) {
  const presets = [5, 10, 50].filter((v) => v * USDT_MICRO <= available);
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">Сумма</span>
      <div className="input with-suffix amount-input">
        <input
          id="transfer-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))}
          placeholder="0"
        />
        <span className="suffix">USDT</span>
      </div>
      <div className="chips">
        {presets.map((v) => (
          <button key={v} className="chip" onClick={() => setAmount(String(v))}>{v} USDT</button>
        ))}
        {available > 0 && (
          <button className="chip" onClick={() => setAmount(String(Math.floor(available / 10_000) / 100))}>Всё: {fmtMicro(Math.floor(available / 10_000) * 10_000)}</button>
        )}
      </div>
      <div className="amount-meta">
        <span>Доступно {fmtMicro(available)}</span>
        <span>Без комиссии</span>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function CommentField({ comment, setComment }: { comment: string; setComment: (v: string) => void }) {
  return (
    <div className="field">
      <span className="field-label">Комментарий, необязательно</span>
      <input
        id="transfer-comment"
        className="input"
        maxLength={MAX_COMMENT_LENGTH}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Например, за обед"
      />
    </div>
  );
}

function Option(props: { icon: ReactNode; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button className="option" onClick={props.onClick}>
      <span className="option-icon">{props.icon}</span>
      <span className="option-text">
        <b>{props.title}</b>
        <span className="muted">{props.subtitle}</span>
      </span>
      <IconChevronRight size={16} className="muted" />
    </button>
  );
}
