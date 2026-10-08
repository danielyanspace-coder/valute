import { legalDoc, type LegalKind } from '../../../shared/legal';
import { Sheet } from './Sheet';

/** Terms of use / privacy policy, opened from the footer of the home screen. */
export function LegalSheet({ kind, supportUsername, onClose }: { kind: LegalKind | null; supportUsername: string; onClose: () => void }) {
  const doc = kind ? legalDoc(kind, supportUsername || 'cryptoix') : null;
  return (
    <Sheet open={!!doc} onClose={onClose} title={doc?.title ?? ''} tall>
      {doc && (
        <article className="legal">
          <p className="legal-updated">Редакция от {doc.updated}</p>
          <p>{doc.intro}</p>
          {doc.sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.body.map((p, i) => (p.startsWith('• ') ? <p key={i} className="legal-li">{p.slice(2)}</p> : <p key={i}>{p}</p>))}
            </section>
          ))}
        </article>
      )}
    </Sheet>
  );
}

export function LegalFooter({ onOpen }: { onOpen: (kind: LegalKind) => void }) {
  return (
    <footer className="legal-footer">
      <button onClick={() => onOpen('terms')}>Условия использования</button>
      <button onClick={() => onOpen('privacy')}>Политика конфиденциальности</button>
      <div className="legal-copy">© {new Date().getFullYear()} Crypto IX</div>
    </footer>
  );
}
