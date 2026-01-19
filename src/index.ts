import type { Env } from './types.js';
import { createWebhookHandler } from './bot.js';
import { handleCron } from './handlers/cron.js';

export default {
  /**
   * Handle incoming HTTP requests (Telegram webhook)
   */
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Process webhook update
    try {
      const handler = createWebhookHandler(env);
      return await handler(request);
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
