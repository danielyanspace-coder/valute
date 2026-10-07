import { useState } from 'react';
import type { MeDto } from '../../../shared/api';
import { fmtRub0 } from '../lib/format';
import { haptic, openTelegramChat } from '../lib/telegram';
import { IconChat, IconChevronRight, IconHelp } from './icons';
import { Sheet } from './Sheet';

interface Props {
  me: MeDto | null;
  onUnavailableSupport: () => void;
}

export function ProfileScreen({ me, onUnavailableSupport }: Props) {
  const [faqOpen, setFaqOpen] = useState(false);
  const u = me?.user;
  const name = u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '';
  const since = me ? new Date(me.stats.memberSince).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <section className="profile">
      <div className="card profile-head">
        <div className="profile-avatar">
          {u?.photoUrl ? <img src={u.photoUrl} alt="" /> : <span>{name.slice(0, 1).toUpperCase() || '·'}</span>}
          <i className="online-dot" />
        </div>
        <b className="profile-name">{name || ' '}</b>
        <span className="profile-username">{u?.username ? `@${u.username}` : 'username скрыт'}</span>
        {since && <span className="profile-since">В Crypto IX с {since}</span>}
      </div>

      <div className="profile-stats">
        <div className="card stat">
          <span className="stat-value">{me?.stats.exchanges ?? 0}</span>
          <span className="stat-label">{plural(me?.stats.exchanges ?? 0, 'обмен', 'обмена', 'обменов')} всего</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{fmtRub0(me?.stats.exchangedRub ?? 0)}</span>
          <span className="stat-label">выведено в рубли</span>
        </div>
      </div>

      <div className="card profile-menu">
        <button
          className="menu-row"
          onClick={() => {
            haptic();
            if (me?.supportUsername) openTelegramChat(me.supportUsername);
            else onUnavailableSupport();
          }}
        >
          <span className="menu-icon support"><IconChat size={18} /></span>
          <span className="menu-text">
            <b>Чат с поддержкой</b>
            <span className="muted">Ответим в Telegram</span>
          </span>
          <IconChevronRight size={16} className="muted" />
        </button>
        <button className="menu-row" onClick={() => { haptic(); setFaqOpen(true); }}>
          <span className="menu-icon help"><IconHelp size={18} /></span>
          <span className="menu-text">
            <b>FAQ</b>
            <span className="muted">Ответы на частые вопросы</span>
          </span>
          <IconChevronRight size={16} className="muted" />
        </button>
      </div>

      <FaqSheet open={faqOpen} onClose={() => setFaqOpen(false)} botUsername={me?.botUsername ?? 'bot'} />
    </section>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const faq = (bot: string): { q: string; a: string }[] => [
  {
    q: 'Как пополнить кошелёк?',
    a: 'Нажмите «Пополнить», скопируйте свой адрес и отправьте на него USDT в сети TRON (TRC-20) с биржи или другого кошелька. Деньги зачислятся автоматически после 20 подтверждений сети, обычно за 1-2 минуты.',
  },
  {
    q: 'Можно пополнить в другой сети?',
    a: 'Нет, только USDT в сети TRON (TRC-20). Монеты в других сетях (ERC-20, BEP-20, TON) не зачислятся, и вернуть их не получится.',
  },
  {
    q: 'Как вывести деньги на карту?',
    a: 'Нажмите «Вывести» → «На банковскую карту», выберите СБП или перевод по номеру карты, введите сумму от 1000 ₽ (кратно 1000 ₽). USDT пересчитаются по курсу кошелька в момент заявки и заморозятся до завершения сделки. Отменить заявку после создания нельзя.',
  },
  {
    q: 'Зачем подтверждать получение?',
    a: 'Когда деньги начнут путь, бот пришлёт уведомление. Проверьте счёт и нажмите «Подтвердить получение». Если пришла другая сумма или деньги не пришли, сообщите об этом в заявке, мы проверим платёж. Без ответа на 5 уведомлений сделка уйдёт на рассмотрение администратора, USDT останутся замороженными.',
  },
  {
    q: 'Как перевести USDT другу?',
    a: `Без комиссии: «Перевести» → «По username», или создайте чек и перешлите ссылку. Ещё быстрее в любом чате: напишите @${bot} 10 и выберите «Отправить чек».`,
  },
  {
    q: 'Какие комиссии?',
    a: 'Пополнение и переводы внутри кошелька бесплатные. При выводе в рубли используется курс кошелька, он показан на главном экране.',
  },
  {
    q: 'Насколько это безопасно?',
    a: 'Вход только через ваш Telegram, каждое поступление проходит автоматическую AML-проверку, выводы проверяет оператор. Не публикуйте ссылки на чеки в открытых чатах: их получит тот, кто нажмёт первым.',
  },
];

function FaqSheet({ open, onClose, botUsername }: { open: boolean; onClose: () => void; botUsername: string }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <Sheet open={open} onClose={onClose} title="FAQ">
      <div className="faq">
        {faq(botUsername).map((item, i) => (
          <div key={i} className={`faq-item ${openIdx === i ? 'open' : ''}`}>
            <button className="faq-q" onClick={() => { haptic(); setOpenIdx(openIdx === i ? null : i); }} aria-expanded={openIdx === i}>
              <span>{item.q}</span>
              <IconChevronRight size={16} className="faq-chevron" />
            </button>
            {openIdx === i && <p className="faq-a">{item.a}</p>}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
