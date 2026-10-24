import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ai } from '../types.js';
import { extractInvoiceData, OcrUnavailableError } from './ocr.js';

// Values read off the real Sirena receipt used to choose the OCR model
const SIRENA = {
  rncEmisor: '101796822',
  rncComprador: '133523191',
  ncf: 'E310012389471',
  fechaEmision: '16-10-2026',
  propina: 0,
  itbis: 11275.93,
  montoTotal: 73920,
};

const image = new Uint8Array([0xff, 0xd8, 0xff]).buffer;

function gemmaAnswer(content: object) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

describe('extractInvoiceData', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the OpenAI-style answer that Gemma 4 returns', async () => {
    const ai: Ai = { run: async () => gemmaAnswer(SIRENA) };
    await expect(extractInvoiceData(image, ai)).resolves.toMatchObject(SIRENA);
  });

  it('reports the model as unavailable when it never answers', async () => {
    vi.useFakeTimers();
    const ai: Ai = { run: () => new Promise(() => {}) };
    const assertion = expect(extractInvoiceData(image, ai)).rejects.toBeInstanceOf(OcrUnavailableError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('reports the model as unavailable when the AI call fails', async () => {
    const ai: Ai = {
      run: async () => {
        throw new Error('AiError: Client Closed Request');
      },
    };
    await expect(extractInvoiceData(image, ai)).rejects.toBeInstanceOf(OcrUnavailableError);
  });

  it('returns null when the model answers but cannot read the receipt', async () => {
    const unreadable = Object.fromEntries(Object.keys(SIRENA).map((field) => [field, null]));
    const ai: Ai = { run: async () => gemmaAnswer(unreadable) };
    await expect(extractInvoiceData(image, ai)).resolves.toBeNull();
  });
});
