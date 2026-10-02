import { httpAdminApi, httpApi, IS_DEMO, type AdminApi, type Api, type MarketCoin, type WalletRate } from './api';
import { createMockBackend } from './mockBackend';

declare const __DEMO_SNAPSHOT__: { rate: WalletRate; coins: MarketCoin[] } | undefined;

const mock = IS_DEMO ? createMockBackend(__DEMO_SNAPSHOT__!) : null;

/** The Mini App talks to the real server, or to the in-browser mock in the demo build. */
export const api: Api = mock ? mock.api : httpApi;

export const adminApi = (token: string): AdminApi => (mock ? mock.admin : httpAdminApi(token));
