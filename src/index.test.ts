import { describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { processUpdate } from './bot.js';
import type { Env } from './types.js';

// Processing that never finishes stands in for a model that hangs
vi.mock('./bot.js', () => ({ processUpdate: vi.fn(() => new Promise<void>(() => {})) }));

const env = { TELEGRAM_WEBHOOK_SECRET: 'secret' } as Env;
const update = { update_id: 1 };

function webhook(secret: string): Request {
  return new Request('https://bot.example/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
}

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

describe('webhook', () => {
  it('answers 200 at once and leaves slow processing to waitUntil', async () => {
    const ctx = executionContext();
    const response = await worker.fetch(webhook('secret'), env, ctx);
    expect(response.status).toBe(200);
    expect(processUpdate).toHaveBeenCalledWith(env, update);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it('rejects requests without the webhook secret', async () => {
    vi.mocked(processUpdate).mockClear();
    const response = await worker.fetch(webhook('wrong'), env, executionContext());
    expect(response.status).toBe(401);
    expect(processUpdate).not.toHaveBeenCalled();
  });
});
