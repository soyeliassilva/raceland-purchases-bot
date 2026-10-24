import type { Update } from 'grammy/types';
import type { Env } from './types.js';
import { processUpdate } from './bot.js';
import { handleCron } from './handlers/cron.js';

export default {
  /**
   * Handle incoming HTTP requests (Telegram webhook)
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify webhook secret (AC11)
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      console.warn('Webhook request rejected: invalid secret token');
      return new Response('Unauthorized', { status: 401 });
    }

    // Answer Telegram before doing any work. Telegram resends every update that
    // is not answered 2xx in time, so slow OCR here made the bot loop.
    try {
      const update = (await request.json()) as Update;
      ctx.waitUntil(processUpdate(env, update));
      return new Response('OK');
    } catch (error) {
      console.error('Error processing webhook:', error);
      return new Response('Internal server error', { status: 500 });
    }
  },

  /**
   * Handle scheduled cron triggers
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      await handleCron(env);
    } catch (error) {
      console.error('Error in scheduled handler:', error);
      throw error;
    }
  },
};
