import { useCallback, useState } from 'react';
import type { HistoryItem, MeDto } from '../../shared/api';
import { USDT_MICRO } from '../../shared/payout';
import { Actions, type ActionId } from './components/Actions';
import { BalanceCard } from './components/BalanceCard';
import { BottomNav, type Tab } from './components/BottomNav';
import { ConfirmBanner } from './components/ConfirmBanner';
import { ContactLock } from './components/ContactLock';
import { CryptoList } from './components/CryptoList';
import { Header } from './components/Header';
import { HistoryScreen } from './components/HistoryScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { ServicesScreen } from './components/ServicesScreen';
import { NotificationHost } from './components/NotificationHost';
import { Promo } from './components/Promo';
import { QrResultSheet } from './components/QrResultSheet';
import { QrScannerOverlay } from './components/QrScanner';
import { RateCard } from './components/RateCard';
import { RateSheet } from './components/RateSheet';
import { Sheet } from './components/Sheet';
import { WithdrawalSheet } from './components/withdraw/WithdrawalSheet';
import { WithdrawFlow } from './components/withdraw/WithdrawFlow';
import { TransferFlow } from './components/transfer/TransferFlow';
import { DepositSheet } from './components/deposit/DepositSheet';
import { OrderSheet, ServiceFlow } from './components/services/ServiceFlows';
import type { ServiceKind } from '../../shared/services';
import { IS_DEMO, type MarketCoin, type WalletRate } from './lib/api';
import { api } from './lib/backend';
import { parseQr, type ParsedQr } from './lib/qr';
import { canUseNativeQr, haptic, hapticNotify, openTelegramChat, tg } from './lib/telegram';
import { readFlag, usePolling, writeFlag } from './lib/useInterval';

const RATE_REFRESH_MS = 15_000;
const ACCOUNT_REFRESH_MS = 10_000;

export function App() {
  const [rate, setRate] = useState<WalletRate | null>(null);
  const [rateError, setRateError] = useState(false);
  const [coins, setCoins] = useState<MarketCoin[]>([]);
  const [me, setMe] = useState<MeDto | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [hidden, setHidden] = useState(() => readFlag('hideBalance'));
  const [tab, setTab] = useState<Tab>('home');
  const [rateOpen, setRateOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [service, setService] = useState<ServiceKind | null>(null);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const [openWithdrawal, setOpenWithdrawal] = useState<number | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [qrResult, setQrResult] = useState<ParsedQr | null>(null);
  const [soon, setSoon] = useState<string | null>(null);

  usePolling(() => {
    api.rate().then((r) => { setRate(r); setRateError(false); }, () => setRateError(true));
    api.market().then((m) => setCoins(m.coins), () => {});
  }, RATE_REFRESH_MS);

  const refreshAccount = useCallback(() => {
    api.me().then(setMe, () => {});
    api.history().then((r) => setHistory(r.items), () => {}).finally(() => setHistoryLoading(false));
  }, []);
  usePolling(refreshAccount, ACCOUNT_REFRESH_MS);

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
    if (id === 'withdraw') return setWithdrawOpen(true);
    if (id === 'transfer') return setTransferOpen(true);
    setDepositOpen(true);
  };

  const toggleHidden = () => {
    setHidden((h) => {
      writeFlag('hideBalance', !h);
      return !h;
    });
  };

  const openW = useCallback((id: number) => {
    setWithdrawOpen(false);
    setOpenWithdrawal(id);
  }, []);

  const awaiting = history.flatMap((h) => (h.type === 'withdrawal' && h.withdrawal.status === 'sent' ? [h.withdrawal] : []));
  const tgUser = tg?.initDataUnsafe.user;
  const headerUser = me
    ? { firstName: me.user.firstName, lastName: me.user.lastName, username: me.user.username, photoUrl: me.user.photoUrl }
    : tgUser
      ? { firstName: tgUser.first_name, lastName: tgUser.last_name, username: tgUser.username, photoUrl: tgUser.photo_url }
      : null;
  const support = me?.supportUsername ?? '';

  return (
    <div className="app">
      <main className="screen">
        <Header
          user={headerUser}
          supportUnread={0}
          onSupport={() => (support ? openTelegramChat(support) : setSoon('Поддержка'))}
          onHelp={() => { setTab('profile'); window.scrollTo(0, 0); }}
          onProfile={() => setTab('profile')}
        />

        {tab === 'home' && (
          <>
            <BalanceCard
              balanceUsd={me ? me.availableMicro / USDT_MICRO : null}
              frozenUsd={(me?.frozenMicro ?? 0) / USDT_MICRO}
              hidden={hidden}
              onToggleHidden={toggleHidden}
            />
            {awaiting.map((w) => (
              <ConfirmBanner key={w.id} w={w} onOpen={() => setOpenWithdrawal(w.id)} />
            ))}
            <Actions onAction={onAction} />
            <RateCard rate={rate} error={rateError} onOpen={() => { haptic(); setRateOpen(true); }} />
            <CryptoList coins={coins} onAll={() => setSoon('Все криптовалюты')} onCoin={(s) => setSoon(s)} />
            <Promo onOpen={() => setTransferOpen(true)} />
            {IS_DEMO && rate && (
              <p className="demo-banner">
                Демо-версия · курсы Rapira на {new Date(rate.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
              </p>
            )}
          </>
        )}

        {tab === 'services' && <ServicesScreen onDeposit={() => setDepositOpen(true)} onWithdraw={() => setWithdrawOpen(true)} onService={setService} />}

        {tab === 'profile' && <ProfileScreen me={me} onUnavailableSupport={() => setSoon('Поддержка')} />}

        {tab === 'history' && (
          <HistoryScreen items={history} loading={historyLoading} onOpenWithdrawal={setOpenWithdrawal} onOpenChecks={() => setTransferOpen(true)} onOpenOrder={setOpenOrder} />
        )}
      </main>

      <BottomNav
        tab={tab}
        onScan={startScan}
        onTab={(t) => {
          haptic();
          setTab(t);
          window.scrollTo(0, 0);
        }}
      />

      <RateSheet rate={rate} open={rateOpen} onClose={() => setRateOpen(false)} />
      <WithdrawFlow
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        me={me}
        rate={rate}
        onCreated={refreshAccount}
        onOpenWithdrawal={openW}
      />
      <DepositSheet open={depositOpen} onClose={() => setDepositOpen(false)} />
      <ServiceFlow
        kind={service}
        onClose={() => setService(null)}
        me={me}
        onCreated={refreshAccount}
        onOpenOrder={(id) => { setService(null); setOpenOrder(id); }}
      />
      <OrderSheet id={openOrder} onClose={() => setOpenOrder(null)} supportUsername={support} />
      <TransferFlow open={transferOpen} onClose={() => setTransferOpen(false)} me={me} onChanged={refreshAccount} />
      <WithdrawalSheet
        id={openWithdrawal}
        onClose={() => setOpenWithdrawal(null)}
        onChanged={refreshAccount}
        supportUsername={support}
        usernameHidden={!!me && !me.user.username}
      />
      <NotificationHost supportUsername={support} onOpenWithdrawal={openW} onAnything={refreshAccount} onOpenOrder={setOpenOrder} />
      {me?.contactLock && <ContactLock lock={me.contactLock} supportUsername={support} />}
      {scannerOpen && <QrScannerOverlay onResult={handleScanned} onClose={() => setScannerOpen(false)} />}
      <QrResultSheet result={qrResult} qrPayRate={rate?.qrPayRate ?? null} onClose={() => setQrResult(null)} onRescan={startScan} />
      <Sheet open={!!soon} onClose={() => setSoon(null)} title={soon ?? ''}>
        <p className="muted">Раздел в разработке, подключим на следующих шагах.</p>
      </Sheet>
    </div>
  );
}
