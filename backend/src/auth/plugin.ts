import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRow } from '../users/userRepo.js';
import { verifyInitData, type TelegramUser } from './telegram.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
  }
}

const DEV_USER: TelegramUser = { id: 1, first_name: 'Dev', username: 'dev_user' };

/**
 * preHandler: expects `Authorization: tma <initData>` sent by the Mini App.
 * Verifies the signature, then creates/refreshes the user and attaches it to the request.
 */
export function requireTelegramAuth(botToken: string, allowDevAuth: boolean, resolve: (tg: TelegramUser) => UserRow) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const verified = verifyInitData(initData, botToken);
    if (verified) {
      req.user = resolve(verified.user);
      return;
    }
    if (allowDevAuth && !initData) {
      req.user = resolve(DEV_USER);
      return;
    }
    return reply.code(401).send({ error: 'unauthorized' });
  };
}
