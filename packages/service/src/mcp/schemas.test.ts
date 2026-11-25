import { describe, expect, it } from 'vitest';
import { AGGREGATE_OBJECTS } from './schemas.ts';

describe('MCP tool schemas', () => {
  it('excludes unsupported approximatePercentile from AGGREGATE_OBJECTS metric types', () => {
    const aggregation = (
      AGGREGATE_OBJECTS.properties as Record<string, { items?: { properties?: { type?: { enum?: string[] } } } }>
    )['aggregation'];

    const types = aggregation?.items?.properties?.type?.enum;

    expect(types).toEqual(['count', 'sum', 'avg', 'min', 'max', 'approximateDistinct', 'exactDistinct']);
    expect(types).not.toContain('approximatePercentile');
  });
});
