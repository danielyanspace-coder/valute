import { useMemo } from 'react';
import { CHECK_IMAGE_HEIGHT, CHECK_IMAGE_WIDTH, checkSvg } from '../../../../shared/checkSvg';
import { shortUsdt } from '../../../../shared/transfers';

/** The same artwork the bot posts to chats. */
export function CheckCard({ amountMicro, dim }: { amountMicro: number; dim?: boolean }) {
  const svg = useMemo(() => checkSvg(shortUsdt(amountMicro), 'Manrope', 56), [amountMicro]);
  return (
    <div
      className={`check-card ${dim ? 'dim' : ''}`}
      style={{ aspectRatio: `${CHECK_IMAGE_WIDTH} / ${CHECK_IMAGE_HEIGHT}` }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
