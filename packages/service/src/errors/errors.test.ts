import { describe, expect, it } from 'vitest';
import { ApiError, errorBody, errorCodeOf, redactedParameters } from './index.ts';

describe('errors', () => {
  it('makes the body with the OSDK error fields and no message', () => {
    const error = new ApiError(404, 'ObjectTypeNotFound', { objectType: 'x' });

    expect(errorBody(error, 'id-1')).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'ObjectTypeNotFound',
      errorInstanceId: 'id-1',
      parameters: { objectType: 'x' },
    });
  });

  it.each([
    [400, 'INVALID_ARGUMENT'],
    [401, 'UNAUTHORIZED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [408, 'TIMEOUT'],
    [409, 'CONFLICT'],
    [413, 'REQUEST_ENTITY_TOO_LARGE'],
    [500, 'INTERNAL'],
  ] as const)('gives status %i the errorCode %s', (status, code) => {
    expect(errorCodeOf(status)).toBe(code);
  });

  it('service/observability#logs: redactedParameters redacts query of an error with a made-up name, and keeps the Query API name of a QueryNotFound', () => {
    expect(redactedParameters('MadeUpError', { query: 'secret', field: 'where' })).toEqual({
      query: '<redacted>',
      field: 'where',
    });

    expect(redactedParameters('QueryNotFound', { query: 'getUser' })).toEqual({ query: 'getUser' });
    expect(redactedParameters('QueryNotFound', { primaryKey: 'k' })).toEqual({ primaryKey: '<redacted>' });
  });
});
