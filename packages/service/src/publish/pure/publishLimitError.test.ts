import { describe, expect, it } from 'vitest';
import { publishLimitError } from './versionLimits.ts';

function postgresError(code: string): Error {
  return Object.assign(new Error('deadlock detected'), { code });
}

describe('publishLimitError', () => {
  it('service/publish#applying: a publish that Postgres stops in a deadlock gets 409 PublishLockTimeout', () => {
    const error = publishLimitError(postgresError('40P01'));

    expect(error?.status).toBe(409);
    expect(error?.errorName).toBe('PublishLockTimeout');

    expect(error?.parameters).toEqual({
      phase: 'version',
      table: 'ontology_registry.product_versions',
      changed: false,
    });
  });

  it('gives no error for another Postgres error, so the caller keeps it', () => {
    expect(publishLimitError(postgresError('42701'))).toBeUndefined();
  });
});
