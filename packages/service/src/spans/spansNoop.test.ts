import { trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { span, sqlTemplate } from './index.ts';
import { recordSpans } from '../tracing.test-utils.ts';

describe('span with no tracer provider', () => {
  it('service/observability#traces: runs run once, returns its value, a promise, and an iterable, and records nothing', async () => {
    const recorder = recordSpans();

    span('publish plan', {}, () => 1);

    expect(recorder.spans().map((s) => s.name)).toEqual(['publish plan']);

    recorder.stop();

    let runs = 0;

    expect(
      span('publish plan', {}, () => {
        runs += 1;

        expect(trace.getActiveSpan()?.isRecording() ?? false).toBe(false);

        return 7;
      }),
    ).toBe(7);

    await expect(span('publish read', {}, async () => 'read')).resolves.toBe('read');

    const items: number[] = [];

    for await (const item of span('sql', {}, async function* () {
      yield 1;

      yield 2;
    }))
      items.push(item);

    expect(() =>
      span('lock wait', {}, () => {
        throw new TypeError('x');
      }),
    ).toThrow(TypeError);

    expect(runs).toBe(1);
    expect(items).toEqual([1, 2]);
    expect(recorder.spans().map((s) => s.name)).toEqual(['publish plan']);
  });

  it('skips lazy sqlTemplate attribute computation when tracing is inactive and computes it when active', () => {
    let computed = 0;

    const attrs = () => {
      computed += 1;

      return { 'sql.template': sqlTemplate({ text: "SELECT 'secret' AS v", values: [] }) };
    };

    expect(span('sql', attrs, () => 'inactive')).toBe('inactive');
    expect(computed).toBe(0);

    const recorder = recordSpans();

    try {
      expect(span('sql', attrs, () => 'active')).toBe('active');
      expect(computed).toBe(1);

      expect(recorder.spans()).toMatchObject([
        {
          name: 'sql',
          attributes: { 'sql.template': 'SELECT ? AS v', 'sentry.op': 'db.query' },
        },
      ]);
    } finally {
      recorder.stop();
    }
  });
});
