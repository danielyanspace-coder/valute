import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
import { IconClose, IconFlash, IconImage } from './icons';

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
}

/**
 * In-app camera scanner used when Telegram's native popup is unavailable
 * (plain browser, old clients). Decoding runs in a web worker.
 */
export function QrScannerOverlay({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hasFlash, setHasFlash] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  const finish = (text: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    scannerRef.current?.stop();
    onResult(text);
  };

  useEffect(() => {
    const video = videoRef.current!;
    const scanner = new QrScanner(video, (r) => finish(r.data), {
      preferredCamera: 'environment',
      maxScansPerSecond: 15,
      returnDetailedScanResult: true,
      // Scan the central square that matches the on-screen frame
      calculateScanRegion: (v) => {
        const size = Math.round(Math.min(v.videoWidth, v.videoHeight) * 0.7);
        return {
          x: Math.round((v.videoWidth - size) / 2),
          y: Math.round((v.videoHeight - size) / 2),
          width: size,
          height: size,
          downScaledWidth: 480,
          downScaledHeight: 480,
        };
      },
    });
    scannerRef.current = scanner;
    scanner
      .start()
      .then(() => scanner.hasFlash().then(setHasFlash))
      .catch(() => setError('Нет доступа к камере. Разрешите доступ или выберите фото с QR-кодом.'));
    return () => {
      scanner.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFlash = async () => {
    await scannerRef.current?.toggleFlash();
    setFlashOn(!!scannerRef.current?.isFlashOn());
  };

  const fromFile = async (file: File) => {
    try {
      const r = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      finish(r.data);
    } catch {
      setError('На изображении не найден QR-код');
    }
  };

  return (
    <div className="scanner">
      <video ref={videoRef} className="scanner-video" playsInline muted />
      <div className="scanner-mask">
        <div className="scanner-frame">
          <i /><i /><i /><i />
          <div className="scanner-line" />
        </div>
      </div>
      <div className="scanner-top">
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><IconClose /></button>
      </div>
      <div className="scanner-hint">
        <b>Наведите камеру на QR-код</b>
        <span>{error ?? 'СБП, счёт на оплату или криптоадрес'}</span>
      </div>
      <div className="scanner-controls">
        <button className="scanner-ctrl" onClick={() => fileRef.current?.click()}>
          <IconImage /> <span>Из галереи</span>
        </button>
        {hasFlash && (
          <button className={`scanner-ctrl ${flashOn ? 'on' : ''}`} onClick={toggleFlash}>
            <IconFlash /> <span>Фонарик</span>
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => e.target.files?.[0] && fromFile(e.target.files[0])}
      />
    </div>
  );
}
