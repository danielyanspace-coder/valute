import { useState } from 'react';
import type { GiveawayDto } from '../../../shared/api';
import { shortUsdt } from '../../../shared/transfers';
import { ApiError } from '../lib/api';
import { api } from '../lib/backend';
import { Confetti } from '../lib/motion';
import { CoinIcon } from './CoinIcon';
import { haptic, hapticNotify } from '../lib/telegram';
import { IconCheck } from './icons';
import { Sheet } from './Sheet';

const fmtLeft = (ms: number) => {
  if (ms <= 0) return 'подводим итоги';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(1, m)} мин`;
};
const fmtEnd = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// ---------- Drawn duotone icons: violet-blue, one gradient per icon so they stay crisp ----------

let gid = 0;
function Duo({ children, size = 26 }: { children: (fill: string) => React.ReactNode; size?: number }) {
  const [id] = useState(() => `gw${++gid}`);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b9a6ff" />
          <stop offset="1" stopColor="#5b67ff" />
        </linearGradient>
      </defs>
      {children(`url(#${id})`)}
    </svg>
  );
}

/** Ticket with a star: free entry. */
const TicketIcon = () => (
  <Duo>{(f) => (<>
    <path d="M4 10a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v3a3 3 0 0 0 0 6v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a3 3 0 0 0 0-6Z" fill={f} />
    <path d="M20 9v14" stroke="#fff" strokeOpacity=".55" strokeWidth="1.4" strokeDasharray="2 2" />
    <path d="m12 12.3 1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4Z" fill="#fff" />
  </>)}</Duo>
);
/** Two dice: random draw. */
const DiceIcon = () => (
  <Duo>{(f) => (<>
    <rect x="4" y="9" width="14" height="14" rx="3.5" fill={f} transform="rotate(-12 11 16)" />
    <rect x="15" y="6" width="13" height="13" rx="3.2" fill="#e6e2ff" transform="rotate(10 21.5 12.5)" />
    <circle cx="8.6" cy="13.6" r="1.4" fill="#fff" /><circle cx="13.6" cy="18.6" r="1.4" fill="#fff" /><circle cx="11.1" cy="16.1" r="1.4" fill="#fff" />
    <circle cx="19.3" cy="10.3" r="1.3" fill="#5b67ff" /><circle cx="23.8" cy="14.6" r="1.3" fill="#5b67ff" />
  </>)}</Duo>
);
/** Scales: equal chances. */
const ScalesIcon = () => (
  <Duo>{(f) => (<>
    <path d="M16 5v20M9 26h14" stroke={f} strokeWidth="2.4" strokeLinecap="round" />
    <path d="M6 10h20" stroke={f} strokeWidth="2.4" strokeLinecap="round" />
    <path d="M3.5 18 7 10.5l3.5 7.5a3.6 3.6 0 0 1-7 0ZM21.5 18 25 10.5l3.5 7.5a3.6 3.6 0 0 1-7 0Z" fill={f} />
    <circle cx="16" cy="6" r="2.2" fill="#fff" />
  </>)}</Duo>
);
/** Hourglass. */
const HourglassIcon = () => (
  <Duo size={22}>{(f) => (<>
    <path d="M8 4h16M8 28h16" stroke={f} strokeWidth="2.6" strokeLinecap="round" />
    <path d="M10 5c0 6 6 8 6 11s-6 5-6 11h12c0-6-6-8-6-11s6-5 6-11Z" fill={f} fillOpacity=".35" />
    <path d="M12.5 26c.8-3 3.5-4 3.5-6s0 0 0 0c0 2 2.7 3 3.5 6Z" fill={f} />
  </>)}</Duo>
);
/** Group of people. */
const PeopleIcon = () => (
  <Duo size={22}>{(f) => (<>
    <circle cx="12" cy="11" r="4.5" fill={f} /><path d="M3.5 26c0-5 3.8-8 8.5-8s8.5 3 8.5 8Z" fill={f} />
    <circle cx="22" cy="12" r="3.6" fill={f} fillOpacity=".5" /><path d="M21 18.6c4.3 0 7.5 2.6 7.5 7.4h-6" fill={f} fillOpacity=".5" />
  </>)}</Duo>
);
/** Cup. */
const CupIcon = () => (
  <Duo size={22}>{(f) => (<>
    <path d="M9 4h14v7a7 7 0 0 1-14 0Z" fill={f} />
    <path d="M9 7H5v2a5 5 0 0 0 5 5M23 7h4v2a5 5 0 0 1-5 5" stroke={f} strokeWidth="2.2" fill="none" />
    <path d="M14 18h4v4h-4ZM10 27a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1H10Z" fill={f} />
    <path d="m16 6.5.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3Z" fill="#fff" />
  </>)}</Duo>
);

/** The hero: deep violet panel, a big glossy gift, coins and sparkles drifting around it. */
function GiveawayHero({ joined }: { joined: boolean }) {
  return (
    <div className="gw-hero" aria-hidden>
      <span className="gw-ray" />
      <span className="gw-float c1"><CoinIcon symbol="USDT" size={30} /></span>
      <span className="gw-float c2"><CoinIcon symbol="USDT" size={22} /></span>
      <span className="gw-float c3"><CoinIcon symbol="USDT" size={18} /></span>
      <svg className="gw-spark s1" viewBox="0 0 20 20"><path d="M10 0c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10Z" /></svg>
      <svg className="gw-spark s2" viewBox="0 0 20 20"><path d="M10 0c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10Z" /></svg>
      <svg className="gw-spark s3" viewBox="0 0 20 20"><path d="M10 0c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10Z" /></svg>
      <i className="gw-bit b1" /><i className="gw-bit b2" /><i className="gw-bit b3" /><i className="gw-bit b4" />
      <svg className={`gw-gift ${joined ? 'open' : ''}`} viewBox="0 0 120 120">
        <defs>
          <linearGradient id="gwBox" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a58bff" /><stop offset="1" stopColor="#4652f0" /></linearGradient>
          <linearGradient id="gwLid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c4b4ff" /><stop offset="1" stopColor="#6672ff" /></linearGradient>
          <linearGradient id="gwRib" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#d9dcff" /></linearGradient>
        </defs>
        <ellipse cx="60" cy="108" rx="34" ry="6" fill="#000" opacity=".35" />
        <rect x="24" y="52" width="72" height="54" rx="10" fill="url(#gwBox)" />
        <rect x="24" y="52" width="72" height="54" rx="10" fill="#fff" opacity=".08" />
        <rect x="53" y="52" width="14" height="54" fill="url(#gwRib)" />
        <g className="gw-lid">
          <rect x="18" y="38" width="84" height="20" rx="8" fill="url(#gwLid)" />
          <rect x="53" y="38" width="14" height="20" fill="url(#gwRib)" />
          <path d="M60 38c-6-14-26-16-24-5 1.6 7 24 5 24 5Zm0 0c6-14 26-16 24-5-1.6 7-24 5-24 5Z" fill="url(#gwRib)" />
          <circle cx="60" cy="38" r="5" fill="#fff" />
        </g>
        <path d="M30 60h12" stroke="#fff" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function GiveawaySheet({ g, open, now, onClose, onChange }: { g: GiveawayDto; open: boolean; now: number; onClose: () => void; onChange: (g: GiveawayDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justJoined, setJustJoined] = useState(false);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.joinGiveaway(g.id));
      hapticNotify('success');
      setJustJoined(true);
    } catch (e) {
      hapticNotify('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось. Попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const share = Math.floor(g.prizeMicro / Math.max(1, g.winners));
  return (
    <Sheet open={open} onClose={onClose} title={g.title}>
      <Confetti fire={justJoined ? 1 : 0} />
      <div className="giveaway-sheet">
        <GiveawayHero joined={g.joined || justJoined} />
        <span className="gw-kicker">{g.status === 'drawn' ? 'Итоги розыгрыша' : 'Призовой фонд'}</span>
        <b className="giveaway-prize">{shortUsdt(g.prizeMicro)} <span className="gw-usdt">USDT</span></b>
        {justJoined && <span className="gw-joined"><IconCheck size={14} /> Вы в игре, удачи!</span>}

        <div className={`giveaway-stats ${g.status === 'active' ? '' : 'two'}`}>
          <div><CupIcon /><span className="muted">Победителей</span><b>{g.winners} × {shortUsdt(share)}</b></div>
          {g.status === 'active' && <div><HourglassIcon /><span className="muted">До итогов</span><b>{fmtLeft(g.endsAt - now)}</b></div>}
          <div><PeopleIcon /><span className="muted">Участников</span><b>{g.participants.toLocaleString('ru-RU')}</b></div>
        </div>

        {g.status === 'drawn' && (
          <div className="giveaway-results">
            {g.results.map((r, i) => (
              <div key={i} className={`giveaway-winner ${r.you ? 'you' : ''}`}>
                <span>{r.you ? 'Вы' : r.name}</span>
                <b>+{shortUsdt(r.prizeMicro)} USDT</b>
              </div>
            ))}
          </div>
        )}

        <div className="rules giveaway-rules">
          <div className="rule"><TicketIcon /><span><b>Бесплатно.</b> Покупать ничего не нужно, достаточно нажать кнопку.</span></div>
          <div className="rule"><DiceIcon /><span><b>Случайный выбор.</b> Итоги {fmtEnd(g.endsAt)}, приз делится поровну и сразу зачисляется на баланс.</span></div>
          <div className="rule"><ScalesIcon /><span><b>Равные шансы.</b> IX Black и сумма операций не влияют. Один аккаунт участвует один раз.</span></div>
        </div>

        {error && <div className="field-error center">{error}</div>}
        {g.status === 'active' && (
          <div className="sheet-actions">
            {g.joined ? (
              <button className="btn ghost block" onClick={onClose}><IconCheck size={16} /> Вы участвуете</button>
            ) : (
              <button className="btn primary block" disabled={busy || g.endsAt <= now} onClick={join}>{busy ? 'Секунду…' : 'Участвовать бесплатно'}</button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
