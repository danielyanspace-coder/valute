import { useCallback, useState } from 'react';
import type { AdminStatsDto, AdminStatsPeriod } from '../../../shared/api';
import { ADMIN_STATUS_LABEL, type DealStatus } from '../../../shared/deals';
import type { AdminApi } from '../lib/api';
import { fmtMicro, fmtRub0 } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { WalletBalances } from './WalletBalances';

/** 1 сделка, 2 сделки, 5 сделок. */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n.toLocaleString('ru-RU')} ${w}`;
};
const deals = (n: number) => plural(n, 'сделка', 'сделки', 'сделок');

const minutes = (m: number | null) => (m === null ? 'нет данных' : m < 60 ? `${m.toLocaleString('ru-RU')} мин` : `${(m / 60).toFixed(1).replace('.', ',')} ч`);
const dayLabel = (t: number) => new Date(t + 3 * 3_600_000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekday = (t: number) => new Date(t + 3 * 3_600_000).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });

/** Turnover and workload: how much went out, how fast, and where the bottleneck is. */
export function StatsPanel({ api, onOpenUser }: { api: AdminApi; onOpenUser: (id: number) => void }) {
  const [stats, setStats] = useState<AdminStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pi, setPi] = useState(0);
  const load = useCallback(() => {
    api.stats().then((s) => { setStats(s); setError(null); }, (e) => setError((e as Error).message));
  }, [api]);
  usePolling(load, 30_000);

  if (!stats) return <div className="adm-empty">{error ?? 'Считаем статистику…'}</div>;
  const p = stats.periods[pi];
  const owed = stats.now.availableMicro + stats.now.frozenMicro;

  return (
    <div className="st">
      <div className="st-periods" role="tablist">
        {stats.periods.map((x, i) => (
          <button key={x.label} role="tab" aria-selected={i === pi} className={i === pi ? 'active' : ''} onClick={() => setPi(i)}>{x.label}</button>
        ))}
      </div>
      {error && <div className="adm-error">{error}</div>}

      <WalletBalances api={api} owedMicro={owed} />

      <div className="st-hero">
        <Tile big label="Выплачено в рублях" value={fmtRub0(p.payoutRub)} sub={`${deals(p.payoutCount)} · ${plural(p.payoutUsers, 'клиент', 'клиента', 'клиентов')} · ${fmtMicro(p.payoutMicro)}`} />
        <Tile label="Средняя сделка" value={p.payoutCount ? fmtRub0(Math.round(p.payoutRub / p.payoutCount)) : 'нет данных'} />
        <Tile label="От заявки до выплаты" value={minutes(p.avgDealMinutes)} sub="в среднем" />
        <Tile label="Ответ клиента" value={minutes(p.avgResponseMinutes)} sub="от «вошли в сделку» до «поступила»" />
      </div>

      <div className="st-grid">
        <Tile label="Пополнения" value={fmtMicro(p.depositMicro)} sub={`${p.depositCount} шт.`} />
        <Tile label="Вывод USDT" value={fmtMicro(p.usdtPayoutMicro)} sub={`${p.usdtPayoutCount} шт. · комиссии ${fmtMicro(p.usdtFeesMicro)}`} />
        <Tile label="Заявки МК" value={fmtRub0(p.ordersRub)} sub={`${p.ordersCount} оплачено`} />
        <Tile label="Переводы внутри" value={fmtMicro(p.transferMicro)} sub={`${p.transferCount} шт.`} />
        <Tile label="Новые пользователи" value={String(p.newUsers)} />
        <Tile label="Создано сделок" value={String(p.dealsCreated)} sub={p.dealsCancelled ? `отменено ${p.dealsCancelled}` : 'без отмен'} />
      </div>

      <PayoutChart days={stats.days} />

      <div className="st-cols">
        <section className="adm-card">
          <div className="adm-card-title">Сейчас</div>
          <NowRow k="Активных сделок" v={String(stats.now.activeDeals)} hint={Object.entries(stats.now.dealsByStatus).map(([s, n]) => `${ADMIN_STATUS_LABEL[s as DealStatus] ?? s}: ${n}`).join(' · ')} />
          <NowRow k="Ждут отправки USDT" v={String(stats.now.usdtPayoutsWaiting)} warn={stats.now.usdtPayoutsWaiting > 0} />
          <NowRow k="Пополнения на проверке" v={String(stats.now.depositsHeld)} warn={stats.now.depositsHeld > 0} />
          <NowRow k="Пользователей всего" v={String(stats.now.usersTotal)} />
          <NowRow k="Балансы клиентов" v={fmtMicro(owed)} hint={`доступно ${fmtMicro(stats.now.availableMicro)}, заморожено ${fmtMicro(stats.now.frozenMicro)}. Столько USDT должно быть у вас в кошельках`} />
        </section>
        <section className="adm-card">
          <div className="adm-card-title">Больше всех выводят · 7 дней</div>
          {stats.topUsers.length === 0 && <div className="adm-muted small">Пока никого</div>}
          {stats.topUsers.map((u, i) => (
            <button key={u.id} className="st-top" onClick={() => onOpenUser(u.id)}>
              <span className="st-top-n">{i + 1}</span>
              <span className="st-top-name">{u.username ? `@${u.username}` : u.firstName}<small>ID {u.id}</small></span>
              <span className="st-top-val">{fmtRub0(u.rub)}<small>{deals(u.deals)}</small></span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div className={`st-tile ${big ? 'big' : ''}`}>
      <span className="st-tile-label">{label}</span>
      <b className="st-tile-value">{value}</b>
      {sub && <span className="st-tile-sub">{sub}</span>}
    </div>
  );
}

function NowRow({ k, v, hint, warn }: { k: string; v: string; hint?: string; warn?: boolean }) {
  return (
    <div className="st-now">
      <span>{k}{hint && <small>{hint}</small>}</span>
      <b className={warn ? 'warn' : ''}>{v}</b>
    </div>
  );
}

/** Ruble payouts per day: one series, bars anchored to the baseline, hover tooltip, table view. */
function PayoutChart({ days }: { days: AdminStatsDto['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 700;
  const H = 180;
  const pad = { top: 12, bottom: 22, left: 4, right: 4 };
  const max = Math.max(1, ...days.map((d) => d.payoutRub));
  const nice = niceMax(max);
  const slot = (W - pad.left - pad.right) / days.length;
  const barW = Math.max(6, slot - 6);
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - v / nice);
  const h = hover !== null ? days[hover] : null;
  const total = days.reduce((s, d) => s + d.payoutRub, 0);

  return (
    <section className="adm-card st-chart">
      <div className="st-chart-head">
        <div>
          <div className="adm-card-title">Выплаты в рублях по дням</div>
          <div className="adm-muted small">14 дней · всего {fmtRub0(total)}</div>
        </div>
        <button className="adm-link" onClick={() => setTable((t) => !t)}>{table ? 'График' : 'Таблица'}</button>
      </div>
      {table ? (
        <table className="st-table">
          <thead><tr><th>День</th><th>Сделок</th><th>Выплачено</th></tr></thead>
          <tbody>
            {days.slice().reverse().map((d) => (
              <tr key={d.day}><td>{dayLabel(d.day)}, {weekday(d.day)}</td><td>{d.payoutCount}</td><td>{fmtRub0(d.payoutRub)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="st-plot" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Выплаты в рублях за 14 дней">
            {[0.5, 1].map((f) => (
              <line key={f} x1={0} x2={W} y1={y(nice * f)} y2={y(nice * f)} className="st-grid-line" />
            ))}
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="st-axis" />
            {days.map((d, i) => {
              const x = pad.left + i * slot + (slot - barW) / 2;
              const top = y(d.payoutRub);
              const bh = y(0) - top;
              return (
                <g key={d.day}>
                  {d.payoutRub > 0 && <path d={roundedTop(x, top, barW, bh, Math.min(4, bh))} className={`st-bar ${hover === i ? 'on' : ''}`} />}
                  <rect x={pad.left + i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          <div className="st-x">
            {days.map((d, i) => <span key={d.day} className={i % 2 === days.length % 2 ? '' : 'skip'}>{dayLabel(d.day).replace('.', '')}</span>)}
          </div>
          <div className="st-ymax">{fmtRub0(nice)}</div>
          {h && hover !== null && (
            <div className="st-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
              <b>{fmtRub0(h.payoutRub)}</b>
              <span>{dayLabel(h.day)}, {weekday(h.day)} · {deals(h.payoutCount)}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
