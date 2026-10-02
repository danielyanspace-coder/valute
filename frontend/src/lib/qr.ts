// Recognises what a scanned QR code is so the app can route it to the right flow.

export type ParsedQr =
  | {
      kind: 'sbp';
      /** NSPK QR id (path segment of qr.nspk.ru link). */
      id: string;
      /** 01 = static (payer enters amount), 02 = dynamic (amount fixed by merchant). */
      qrType: 'static' | 'dynamic' | 'unknown';
      amountRub?: number;
      bankId?: string;
      raw: string;
    }
  | {
      /** ГОСТ Р 56042-2014 payment QR (utility bills, invoices): ST00012|Name=...|Sum=... */
      kind: 'invoice';
      payee?: string;
      purpose?: string;
      amountRub?: number;
      raw: string;
    }
  | { kind: 'crypto'; network: CryptoNetwork; address: string; amount?: number; raw: string }
  | { kind: 'url'; url: string; raw: string }
  | { kind: 'text'; raw: string };

export type CryptoNetwork = 'TRC20' | 'EVM' | 'TON' | 'SOL';

const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const TON_RE = /^[EUk0]Q[A-Za-z0-9_-]{46}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseQr(input: string): ParsedQr {
  const raw = input.trim();

  const sbp = parseSbp(raw);
  if (sbp) return sbp;

  if (/^ST0001[12]\|/.test(raw)) return parseGostInvoice(raw);

  const crypto = parseCrypto(raw);
  if (crypto) return crypto;

  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw, raw };
  return { kind: 'text', raw };
}

function parseSbp(raw: string): ParsedQr | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^(qr|sub)\.nspk\.ru$/i.test(url.hostname)) return null;
  const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  const type = url.searchParams.get('type');
  const sum = url.searchParams.get('sum');
  return {
    kind: 'sbp',
    id,
    qrType: type === '01' ? 'static' : type === '02' ? 'dynamic' : 'unknown',
    // NSPK passes the amount in kopecks
    amountRub: sum && /^\d+$/.test(sum) ? Number(sum) / 100 : undefined,
    bankId: url.searchParams.get('bank') ?? undefined,
    raw,
  };
}

function parseGostInvoice(raw: string): ParsedQr {
  const fields = new Map<string, string>();
  for (const part of raw.split('|').slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
  }
  const sum = fields.get('sum');
  return {
    kind: 'invoice',
    payee: fields.get('name'),
    purpose: fields.get('purpose'),
    amountRub: sum && /^\d+$/.test(sum) ? Number(sum) / 100 : undefined,
    raw,
  };
}

function parseCrypto(raw: string): ParsedQr | null {
  // Bare addresses
  if (TRON_RE.test(raw)) return { kind: 'crypto', network: 'TRC20', address: raw, raw };
  if (EVM_RE.test(raw)) return { kind: 'crypto', network: 'EVM', address: raw, raw };
  if (TON_RE.test(raw)) return { kind: 'crypto', network: 'TON', address: raw, raw };

  // URI schemes: tron:, ethereum: (EIP-681), ton://transfer/, solana:
  const m = raw.match(/^(tron|ethereum|ton|solana):(?:\/\/transfer\/)?([^?@/]+)([^?]*)(?:\?(.*))?$/i);
  if (!m) return null;
  const [, scheme, target, path, query = ''] = m;
  const params = new URLSearchParams(query);
  const amountRaw = params.get('amount');
  const amount = amountRaw && !Number.isNaN(Number(amountRaw)) ? Number(amountRaw) : undefined;

  switch (scheme.toLowerCase()) {
    case 'tron':
      return TRON_RE.test(target) ? { kind: 'crypto', network: 'TRC20', address: target, amount, raw } : null;
    case 'ethereum': {
      // ethereum:<token>@<chain>/transfer?address=<recipient>&uint256=...
      const recipient = path.includes('/transfer') ? params.get('address') ?? '' : target;
      return EVM_RE.test(recipient) ? { kind: 'crypto', network: 'EVM', address: recipient, amount, raw } : null;
    }
    case 'ton':
      return TON_RE.test(target) ? { kind: 'crypto', network: 'TON', address: target, raw } : null;
    case 'solana':
      return SOL_RE.test(target) ? { kind: 'crypto', network: 'SOL', address: target, amount, raw } : null;
  }
  return null;
}
