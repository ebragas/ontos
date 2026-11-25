import { describe, expect, it } from 'vitest';
import { writeLimitSql } from './sql.ts';

describe('writeLimitSql', () => {
  it('service/storage#writes: the limit statement of 1 ms sets transaction_timeout to 1ms and statement_timeout to 0', () => {
    expect(writeLimitSql(1)).toEqual({
      text: "SELECT set_config('transaction_timeout', $1, true), set_config('statement_timeout', '0', true)",
      values: ['1ms'],
    });
  });

  it('service/storage#writes: 0, a negative number, and a fraction each throw', () => {
    expect(() => writeLimitSql(0)).toThrow(
      'The limit of a write transaction is a whole number of ms, at least 1, not 0.',
    );

    expect(() => writeLimitSql(-5)).toThrow(
      'The limit of a write transaction is a whole number of ms, at least 1, not -5.',
    );

    expect(() => writeLimitSql(1.5)).toThrow(
      'The limit of a write transaction is a whole number of ms, at least 1, not 1.5.',
    );
  });
});
