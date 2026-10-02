import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyInitData, type TelegramUser } from './telegram.js';

declare module 'fastify' {
  interface FastifyRequest {
    tgUser?: TelegramUser;
  }
}

const DEV_USER: TelegramUser = { id: 1, first_name: 'Dev', username: 'dev_user' };

/** preHandler: expects `Authorization: tma <initData>` sent by the Mini App. */
export function requireTelegramAuth(botToken: string, allowDevAuth: boolean) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const verified = verifyInitData(initData, botToken);
    if (verified) {
      req.tgUser = verified.user;
      return;
    }
    if (allowDevAuth && !initData) {
      req.tgUser = DEV_USER;
      return;
    }
    return reply.code(401).send({ error: 'unauthorized' });
  };
}
