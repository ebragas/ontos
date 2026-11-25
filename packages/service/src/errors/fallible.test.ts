import { describe, expect, it } from 'vitest';
import {
  all,
  attempt,
  caught,
  each,
  invariant,
  mapStream,
  orThrow,
  outcome,
  settle,
  step,
  type AsyncFallible,
  type Fallible,
  type FallibleStream,
} from './fallible.ts';

function* half(n: number): Fallible<number, string> {
  if (n % 2 !== 0) return yield `${n} is odd`;

  return n / 2;
}

async function* halfLater(n: number): AsyncFallible<number, string> {
  await Promise.resolve();

  return yield* half(n);
}

describe('settle', () => {
  it('gives the value, or the first failure', async () => {
    expect(settle(half(4))).toEqual({ ok: true, value: 2 });
    expect(settle(half(3))).toEqual({ ok: false, error: '3 is odd' });

    expect(await settle(halfLater(3))).toEqual({ ok: false, error: '3 is odd' });
  });

  it('ends the generator after a failure, so each finally block runs', () => {
    const ran: string[] = [];

    function* guarded(): Fallible<number, string> {
      try {
        return yield* half(1);
      } finally {
        ran.push('finally');
      }
    }

    expect(settle(guarded()).ok).toBe(false);
    expect(ran).toEqual(['finally']);
  });

  it('throws a defect when a finally block yields a failure after an earlier failure, so no failure is lost', async () => {
    function* cleanup(): Fallible<number, string> {
      try {
        return yield* half(1);
      } finally {
        yield* half(3);
      }
    }

    async function* cleanupLater(): AsyncFallible<number, string> {
      try {
        return yield* half(1);
      } finally {
        yield* half(3);
      }
    }

    expect(() => settle(cleanup())).toThrow('A finally block yielded a failure');

    await expect(settle(cleanupLater())).rejects.toThrow('A finally block yielded a failure');
  });
});

describe('orThrow', () => {
  it('gives the value, or throws the failure', async () => {
    expect(orThrow(half(4))).toBe(2);
    expect(() => orThrow(half(3))).toThrow('3 is odd');

    await expect(orThrow(halfLater(3))).rejects.toBe('3 is odd');
  });
});

describe('each', () => {
  it('maps each item in order, and ends at the first failure', () => {
    expect(settle(each([2, 4], (n) => half(n)))).toEqual({ ok: true, value: [1, 2] });
    expect(settle(each([2, 3, 5], (n) => half(n)))).toEqual({ ok: false, error: '3 is odd' });
  });
});

describe('all', () => {
  async function* timed(n: number, ms: number, ran: number[]): AsyncFallible<number, string> {
    try {
      await new Promise((resolve) => setTimeout(resolve, ms));

      return yield* half(n);
    } finally {
      ran.push(n);
    }
  }

  it('gives the values in input order', async () => {
    expect(await settle(all([timed(4, 20, []), timed(2, 0, [])]))).toEqual({ ok: true, value: [2, 1] });

    expect(await settle(all([]))).toEqual({ ok: true, value: [] });
  });

  it('gives the first failure in input order, after each run ends, so each finally runs', async () => {
    const ran: number[] = [];

    expect(await settle(all([timed(4, 0, ran), timed(3, 20, ran), timed(5, 0, ran)]))).toEqual({
      ok: false,
      error: '3 is odd',
    });

    expect(ran.sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it('rejects on a defect after each run ends, so each finally runs', async () => {
    const ran: number[] = [];

    async function* defect(): AsyncFallible<number, string> {
      invariant(false, 'broken');

      return yield* half(2);
    }

    await expect(settle(all([defect(), timed(4, 20, ran)]))).rejects.toThrow('broken');

    expect(ran).toEqual([4]);

    await expect(settle(all([timed(3, 0, ran), defect()]))).rejects.toThrow('broken');
  });
});

describe('caught and attempt', () => {
  it('turn a throw or a rejection into a failure', async () => {
    expect(caught(() => JSON.parse('{'))).toMatchObject({ ok: false });

    expect(await caught(() => Promise.resolve(1))).toEqual({ ok: true, value: 1 });

    expect(
      await settle(
        attempt(
          () => Promise.reject(new Error('down')),
          (error) => `lost: ${String(error)}`,
        ),
      ),
    ).toEqual({ ok: false, error: 'lost: Error: down' });
  });

  it('gives a Promise for an async callback, so a synchronous throw of an outside call settles as a failure', async () => {
    const outside = (): Promise<number> => {
      throw new Error('sync');
    };

    expect(caught(() => outside())).toMatchObject({ ok: false });

    const answer = caught(async () => outside());

    expect(answer).toBeInstanceOf(Promise);

    expect(await answer).toMatchObject({ ok: false, error: new Error('sync') });
  });
});

describe('invariant and outcome', () => {
  it('throws a defect whose stack starts at the defect site', () => {
    const defect = caught(() => invariant(false, 'never'));

    expect(defect.ok).toBe(false);
    expect(String((defect as { error: Error }).error.stack).split('\n')[1]).not.toMatch(/at invariant/);
  });

  it('keeps the cause of a defect, and sets none when none is given', () => {
    const reason = new SyntaxError('bad');

    expect((caught(() => invariant(false, 'never', reason)) as { error: Error }).error.cause).toBe(reason);
    expect('cause' in (caught(() => invariant(false, 'never')) as { error: Error }).error).toBe(false);
  });

  it('gives the value, the failure, or the thrown value of a border', async () => {
    expect(await outcome(() => halfLater(4))).toEqual({ ok: true, value: 2 });

    expect(await outcome(() => halfLater(3))).toEqual({ ok: false, error: '3 is odd' });

    expect(await outcome(() => Promise.reject(new Error('fault')))).toMatchObject({
      ok: false,
      error: new Error('fault'),
    });
  });
});

describe('a stream that returns its failure', () => {
  let ended = 0;

  async function* numbers(count: number, failure?: string): FallibleStream<number, string> {
    try {
      for (let n = 1; n <= count; n += 1) yield n;

      return failure;
    } finally {
      ended += 1;
    }
  }

  const read = async <T>(stream: FallibleStream<T, string>): Promise<{ items: T[]; failure: string | undefined }> => {
    const items: T[] = [];

    for (;;) {
      const next = await stream.next();

      if (next.done) return { items, failure: next.value };

      items.push(next.value);
    }
  };

  it('mapStream gives each item that the function keeps, and returns the failure of its source', async () => {
    const odd = (n: number) => (n % 2 === 1 ? `item ${n}` : undefined);

    expect(await read(mapStream(numbers(3), odd))).toEqual({ items: ['item 1', 'item 3'], failure: undefined });

    expect(await read(mapStream(numbers(2, 'cut'), odd))).toEqual({ items: ['item 1'], failure: 'cut' });
  });

  it('mapStream ends its source when its reader stops, and when the function throws', async () => {
    ended = 0;

    const stopped = mapStream(numbers(3), (n) => n);

    await stopped.next();

    await stopped.return(undefined);

    expect(ended).toBe(1);

    const thrown = mapStream(numbers(3), () => invariant(false, 'defect'));

    await expect(thrown.next()).rejects.toThrow('defect');

    expect(ended).toBe(2);
  });

  it('step gives the next item or the end, and yields the failure of a stream that ends with one', async () => {
    const stream = numbers(1);

    expect(await settle(step(stream))).toEqual({ ok: true, value: { done: false, value: 1 } });

    expect(await settle(step(stream))).toEqual({ ok: true, value: { done: true } });

    expect(await settle(step(numbers(0, 'cut')))).toEqual({ ok: false, error: 'cut' });
  });
});
