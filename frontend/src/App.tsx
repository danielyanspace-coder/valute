import { useCallback, useState } from 'react';
import { Actions, type ActionId } from './components/Actions';
import { BalanceCard } from './components/BalanceCard';
import { BottomNav, type Tab } from './components/BottomNav';
import { CryptoList } from './components/CryptoList';
import { Header } from './components/Header';
import { Promo } from './components/Promo';
import { QrResultSheet } from './components/QrResultSheet';
import { QrScannerOverlay } from './components/QrScanner';
import { RateCard } from './components/RateCard';
import { RateSheet } from './components/RateSheet';
import { Sheet } from './components/Sheet';
import { api, type MarketCoin, type WalletRate } from './lib/api';
import { parseQr, type ParsedQr } from './lib/qr';
import { canUseNativeQr, haptic, hapticNotify, tg } from './lib/telegram';
import { readFlag, usePolling, writeFlag } from './lib/useInterval';

const RATE_REFRESH_MS = 15_000;

export function App() {
  const user = tg?.initDataUnsafe.user ?? null;
  const [rate, setRate] = useState<WalletRate | null>(null);
  const [rateError, setRateError] = useState(false);
  const [coins, setCoins] = useState<MarketCoin[]>([]);
  const [hidden, setHidden] = useState(() => readFlag('hideBalance'));
  const [tab, setTab] = useState<Tab>('home');
  const [rateOpen, setRateOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [qrResult, setQrResult] = useState<ParsedQr | null>(null);
  const [soon, setSoon] = useState<string | null>(null);

  usePolling(() => {
    api.rate().then((r) => { setRate(r); setRateError(false); }, () => setRateError(true));
    api.market().then((m) => setCoins(m.coins), () => {});
  }, RATE_REFRESH_MS);

  const handleScanned = useCallback((text: string) => {
    hapticNotify('success');
    setScannerOpen(false);
    setQrResult(parseQr(text));
  }, []);

  const startScan = useCallback(() => {
    haptic('medium');
    setQrResult(null);
    if (canUseNativeQr()) {
      tg!.showScanQrPopup({ text: 'СБП, счёт или криптоадрес' }, (text) => {
        handleScanned(text);
        return true; // close popup
      });
    } else {
      setScannerOpen(true);
    }
  }, [handleScanned]);

  const onAction = (id: ActionId) => {
    haptic();
    if (id === 'pay') return startScan();
    setSoon({ deposit: 'Пополнение', withdraw: 'Вывод', transfer: 'Перевод' }[id]);
  };

  const toggleHidden = () => {
    setHidden((h) => {
      writeFlag('hideBalance', !h);
      return !h;
    });
  };

  return (
    <div className="app">
      <main className="screen">
        <Header
          user={user}
          supportUnread={0}
          onSupport={() => setSoon('Поддержка')}
          onHelp={() => setSoon('Помощь')}
          onProfile={() => setSoon('Профиль')}
        />
        <BalanceCard balanceUsd={0} change24hUsd={0} change24hPct={0} hidden={hidden} onToggleHidden={toggleHidden} />
        <Actions onAction={onAction} />
        <RateCard rate={rate} error={rateError} onOpen={() => { haptic(); setRateOpen(true); }} />
        <CryptoList coins={coins} onAll={() => setSoon('Все криптовалюты')} onCoin={(s) => setSoon(s)} />
        <Promo onOpen={() => setSoon('Переводы')} />
      </main>

      <BottomNav
        tab={tab}
        onScan={startScan}
        onTab={(t) => {
          haptic();
          if (t === 'home') return setTab(t);
          setSoon({ history: 'История', services: 'Сервисы', profile: 'Профиль' }[t]);
        }}
      />

      <RateSheet rate={rate} open={rateOpen} onClose={() => setRateOpen(false)} />
      {scannerOpen && <QrScannerOverlay onResult={handleScanned} onClose={() => setScannerOpen(false)} />}
      <QrResultSheet result={qrResult} walletRate={rate?.walletRate ?? null} onClose={() => setQrResult(null)} onRescan={startScan} />
      <Sheet open={!!soon} onClose={() => setSoon(null)} title={soon ?? ''}>
        <p className="muted">Раздел в разработке — подключим на следующих шагах.</p>
      </Sheet>
    </div>
  );
}
