import { useCallback, useState } from 'react';
import type { AdminBroadcastDto, BroadcastRequest } from '../../../shared/api';
import type { AdminApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { ConfirmDialog, type ConfirmRequest } from './ui';

/** Telegram HTML subset → safe preview markup. */
function previewHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/&lt;(\/?)(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote)&gt;/g, '<$1$2>')
    .replace(/&lt;a href="(https?:\/\/[^"]+)"&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">')
    .replace(/&lt;\/a&gt;/g, '</a>')
    .replace(/&lt;tg-spoiler&gt;|&lt;\/tg-spoiler&gt;/g, '')
    .replace(/\n/g, '<br>');
}

const readFile = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** Mass messages to every bot user: compose, preview, send to yourself, then to everyone. */
export function BroadcastsPanel({ api }: { api: AdminApi }) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [buttonText, setButtonText] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');
  const [items, setItems] = useState<AdminBroadcastDto[]>([]);
  const [info, setInfo] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.broadcasts().then((r) => setItems(r.items), () => {});
  }, [api]);
  usePolling(load, 4000);

  const req = (): BroadcastRequest => ({ text, photoBase64: photo, buttonText: buttonText || null, buttonUrl: buttonUrl || null });
  const test = async () => {
    setBusy(true);
    setInfo(null);
    try {
      const r = await api.broadcastTest(req());
      setInfo(r.ok ? { ok: true, text: 'Проверочное сообщение отправлено вам в Telegram' } : { ok: false, text: `Telegram не принял сообщение: ${r.error}` });
    } catch (e) {
      setInfo({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ab-page">
      <div className="ab-bc">
        <div className="ab-bc-form adm-card">
          <div className="adm-card-title">Новая рассылка</div>
          <label className="adm-field">
            <span>Текст. Форматирование Telegram: &lt;b&gt;жирный&lt;/b&gt;, &lt;i&gt;курсив&lt;/i&gt;, &lt;a href="https://…"&gt;ссылка&lt;/a&gt;</span>
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: Плановые технические работы сегодня с 02:00 до 03:00 по Москве." />
          </label>
          <div className="adm-muted small">{text.length} / {photo ? 1024 : 4096} символов</div>
          <div className="adm-field">
            <span>Картинка (необязательно, JPG или PNG до 5 МБ)</span>
            <div className="ab-file">
              <label className="adm-btn">
                {photo ? 'Заменить картинку' : 'Выбрать картинку'}
                <input type="file" accept="image/jpeg,image/png" hidden onChange={async (e) => { const f = e.target.files?.[0]; setPhoto(f ? await readFile(f) : null); e.target.value = ''; }} />
              </label>
              {photo && <button className="adm-link" onClick={() => setPhoto(null)}>Убрать</button>}
            </div>
          </div>
          <div className="ab-two">
            <label className="adm-field"><span>Кнопка: текст</span><input value={buttonText} onChange={(e) => setButtonText(e.target.value)} placeholder="Открыть кошелёк" /></label>
            <label className="adm-field"><span>Кнопка: ссылка</span><input value={buttonUrl} onChange={(e) => setButtonUrl(e.target.value)} placeholder="https://t.me/…" /></label>
          </div>
          {info && <div className={`adm-banner ${info.ok ? 'ok' : 'danger'}`}>{info.text}</div>}
          <div className="adm-actions">
            <button className="adm-btn big" disabled={busy || (!text.trim() && !photo)} onClick={test}>Отправить себе</button>
            <button
              className="adm-btn primary big"
              disabled={busy || (!text.trim() && !photo)}
              onClick={() =>
                setConfirm({
                  title: 'Отправить всем пользователям?',
                  text: 'Сообщение уйдёт всем пользователям бота. Отменить отправку будет нельзя. Сначала проверьте его кнопкой «Отправить себе».',
                  confirmLabel: 'Отправить всем',
                  tone: 'primary',
                  run: async () => {
                    await api.broadcastSend(req());
                    setText('');
                    setPhoto(null);
                    setButtonText('');
                    setButtonUrl('');
                    load();
                  },
                })
              }
            >
              Отправить всем
            </button>
          </div>
        </div>
        <div className="ab-bc-preview">
          <div className="adm-card-title">Предпросмотр</div>
          <div className="ab-tg">
            <div className="ab-tg-bubble">
              {photo && <img src={photo} alt="" />}
              {text ? <div dangerouslySetInnerHTML={{ __html: previewHtml(text) }} /> : <div className="adm-muted">Текст сообщения</div>}
            </div>
            {buttonText && <div className="ab-tg-button">{buttonText}</div>}
          </div>
        </div>
      </div>

      <h3 className="ab-h">История рассылок</h3>
      {items.length === 0 && <div className="adm-empty">Рассылок ещё не было</div>}
      <div className="ab-list">
        {items.map((b) => (
          <div key={b.id} className="adm-card ab-bc-item">
            <div className="ab-ob-top">
              <b>#{b.id} · {fmtDateTime(b.createdAt)} · {b.author}</b>
              <span className={`ab-chip bc-${b.status}`}>{b.status === 'sending' ? 'Отправляется' : b.status === 'done' ? 'Отправлена' : 'Ошибка'}</span>
            </div>
            <div className="ab-bc-text" dangerouslySetInnerHTML={{ __html: previewHtml(b.text) }} />
            <div className="ab-progress"><span style={{ width: `${b.total ? Math.round(((b.sent + b.failed + b.blocked) / b.total) * 100) : 100}%` }} /></div>
            <div className="adm-muted small">
              Получателей {b.total} · доставлено {b.sent} · заблокировали бота {b.blocked} · ошибок {b.failed}
              {b.hasPhoto ? ' · с картинкой' : ''}{b.buttonText ? ` · кнопка «${b.buttonText}»` : ''}
            </div>
            {b.errors.length > 0 && (
              <details>
                <summary className="adm-link">Ошибки ({b.errors.length})</summary>
                {b.errors.map((e) => <div key={e.userId} className="adm-muted small">{e.username ? `@${e.username}` : `#${e.userId}`}: {e.error}</div>)}
              </details>
            )}
          </div>
        ))}
      </div>
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
