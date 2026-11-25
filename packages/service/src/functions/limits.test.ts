import { describe, expect, it } from 'vitest';
import { HEAP_LIMIT_MIB, TIME_LIMIT_MS, WAIT_LIMIT_MS } from './limits.ts';

describe('the limits of a Function call', () => {
  it('ontology/functions/functions#runtime: the time limit is 60 seconds, and the heap limit is 1024 MiB', () => {
    expect([TIME_LIMIT_MS, HEAP_LIMIT_MIB]).toEqual([60_000, 1024]);
  });

  it('a call waits for a free worker for up to 25 seconds', () => {
    expect(WAIT_LIMIT_MS).toBe(25_000);
  });
});
