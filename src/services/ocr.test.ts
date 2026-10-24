import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ai } from '../types.js';
import { classifyInvoiceDate, extractInvoiceData, OcrUnavailableError, parseReceiptDate } from './ocr.js';

// 11:00 in Santo Domingo on the day the Sirena receipt date was misread
const NOW = new Date('2026-10-24T15:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const ai: Ai = { run: async () => gemmaAnswer({ ...SIRENA, fechaEmision: '16/10/26' }) };
    await expect(extractInvoiceData(image, ai)).resolves.toMatchObject(SIRENA);
  });

  it('drops a future date and keeps what was read so the user can correct it', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const ai: Ai = { run: async () => gemmaAnswer({ ...SIRENA, fechaEmision: '26/10/26' }) };
    const result = await extractInvoiceData(image, ai);
    expect(result?.fechaEmision).toBeUndefined();
    expect(result?.fechaRejectedFuture).toBe('26-10-2026');
  });

  it('flags a date from before last month', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const ai: Ai = { run: async () => gemmaAnswer({ ...SIRENA, fechaEmision: '26/10/16' }) };
    const result = await extractInvoiceData(image, ai);
    expect(result?.fechaEmision).toBe('26-10-2016');
    expect(result?.fechaBeforeLastMonth).toBe(true);
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

describe('parseReceiptDate', () => {
  it.each([
    ['16/10/26', '2026-10-16'],
    ['16/10/26 23:00:20', '2026-10-16'],
    ['6/10/26', '2026-10-06'],
    ['21/10/2026', '2026-10-21'],
    ['2026-10-21', '2026-10-21'],
  ])('reads %s day first', (printed, iso) => {
    expect(parseReceiptDate(printed)?.toISOString().slice(0, 10)).toBe(iso);
  });
});

describe('classifyInvoiceDate', () => {
  it('accepts this month and last month', () => {
    expect(classifyInvoiceDate(day('2026-10-24'), NOW)).toBe('ok');
    expect(classifyInvoiceDate(day('2026-09-01'), NOW)).toBe('ok');
  });

  it('flags anything before last month', () => {
    expect(classifyInvoiceDate(day('2026-08-31'), NOW)).toBe('old');
    expect(classifyInvoiceDate(day('2016-10-26'), NOW)).toBe('old');
  });

  it('rejects the future', () => {
    expect(classifyInvoiceDate(day('2026-10-26'), NOW)).toBe('future');
  });

  it('uses Dominican time, where 02:00 UTC on the 25th is still the 24th', () => {
    const lateNight = new Date('2026-10-25T02:00:00Z');
    expect(classifyInvoiceDate(day('2026-10-24'), lateNight)).toBe('ok');
    expect(classifyInvoiceDate(day('2026-10-25'), lateNight)).toBe('future');
  });

  it('treats December as last month in January', () => {
    const january = new Date('2027-01-10T15:00:00Z');
    expect(classifyInvoiceDate(day('2026-12-01'), january)).toBe('ok');
    expect(classifyInvoiceDate(day('2026-11-30'), january)).toBe('old');
  });
});
