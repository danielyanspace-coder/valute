import { describe, expect, it } from 'vitest';
import { tronAddressFromHex, tronAddressToHex } from './tronHd.js';
import { balanceFromAccount, USDT_TRC20, verdictFromTxInfo } from './tronClient.js';

// Real mainnet tx: 5 USDT from TYr4DL... to TV6MuM... (solidity node response).
const INFO = {
  id: 'ce7276122f82ad87c3fa1d58b66343e69ae58747a7631a54890cf6523f5b9a82',
  blockNumber: 86182823,
  blockTimeStamp: 1789220535000,
  contract_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
  receipt: { result: 'SUCCESS' },
  log: [
    {
      address: 'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
      topics: [
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '000000000000000000000000faf0a52cfb2648025538e4cbf3dee7bbad7a2658',
        '000000000000000000000000d1c4bb7b2f39aba5707711719b2236b5b605af2e',
      ],
      data: '00000000000000000000000000000000000000000000000000000000004c4b40',
    },
  ],
};
const TO = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';

describe('verdictFromTxInfo', () => {
  it('reads the USDT Transfer to our address', () => {
    expect(verdictFromTxInfo(INFO, TO)).toEqual({
      state: 'confirmed',
      valueMicro: 5_000_000,
      from: 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWq',
      blockNumber: 86182823,
      blockTimestamp: 1789220535000,
    });
  });

  it('is unconfirmed until the solidity node knows the tx', () => {
    expect(verdictFromTxInfo({}, TO)).toEqual({ state: 'unconfirmed' });
  });

  it('rejects reverted txs, other recipients and fake tokens', () => {
    expect(verdictFromTxInfo({ ...INFO, receipt: { result: 'REVERT' } }, TO).state).toBe('failed');
    expect(verdictFromTxInfo(INFO, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH').state).toBe('failed');
    const fake = { ...INFO, log: [{ ...INFO.log[0], address: '1111111111111111111111111111111111111111' }] };
    expect(verdictFromTxInfo(fake, TO).state).toBe('failed');
  });
});

describe('hex addresses', () => {
  it('round-trips', () => {
    expect(tronAddressToHex(TO)).toBe('41d1c4bb7b2f39aba5707711719b2236b5b605af2e');
    expect(tronAddressFromHex('d1c4bb7b2f39aba5707711719b2236b5b605af2e')).toBe(TO);
  });
});

describe('balanceFromAccount', () => {
  it('counts only the Tether contract and TRX; a new address is all zeros', () => {
    const account = {
      balance: 12_500_000,
      trc20: [{ TXL6rJbvmjD46zeN1JssfgxvSo99qC8MRT: '999000000' }, { [USDT_TRC20]: '157939862582' }],
    };
    expect(balanceFromAccount(account)).toEqual({ usdtMicro: 157_939_862_582, trxSun: 12_500_000 });
    expect(balanceFromAccount(undefined)).toEqual({ usdtMicro: 0, trxSun: 0 });
    expect(balanceFromAccount({ balance: 0 })).toEqual({ usdtMicro: 0, trxSun: 0 });
  });
});
