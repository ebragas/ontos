import { describe, expect, it } from 'vitest';
import { settle } from '../../errors/index.ts';
import { compileOrThrow, NS, stored, twinFunctions, twinIr } from '../../ontology/stored.test-utils.ts';
import { TEST_READER } from '../../service.test-utils.ts';
import { compileAggregation, readAggregateRequest } from './aggregation.ts';
import { DerivedUses } from './derived.ts';
import { compileObjectSet } from './objectSet.ts';
import { bodyChecksum } from './pageToken.ts';
import { readLoadObjectsRequest } from './request.ts';
import { compileWhere, TextSearchBudget } from './where.ts';

const ENGAGEMENT = `${NS}Engagement`;
const ontology = compileOrThrow(stored(twinIr('0.6.3'), { functions: twinFunctions('0.6.3') }));

function compileFor(maxGroupCount: number) {
  const request = settle(
    readAggregateRequest({
      objectSet: { type: 'base', objectType: ENGAGEMENT },
      groupBy: [{ type: 'exact', field: 'status', maxGroupCount }],
      aggregation: [{ type: 'count', name: 'count' }],
    }),
  );

  if (!request.ok) throw request.error;

  const set = settle(compileObjectSet(TEST_READER, request.value.objectSet, ontology, new DerivedUses()));

  if (!set.ok) throw set.error;

  return settle(compileAggregation(request.value, set.value));
}

describe('compileAggregation maxGroupCount cap', () => {
  it('allows maxGroupCount at the 10,000 upper bound', () => {
    const compiled = compileFor(10_000);

    expect(compiled.ok).toBe(true);

    if (!compiled.ok) return;

    expect(compiled.value.sql().values).toContain(10_000);
  });

  it.each([10_001, Number.MAX_SAFE_INTEGER])(
    'refuses maxGroupCount %s above 10,000 with 400 Default:InvalidArgument',
    (maxGroupCount) => {
      const compiled = compileFor(maxGroupCount);

      expect(compiled.ok).toBe(false);

      if (compiled.ok) return;

      expect(compiled.error).toMatchObject({
        status: 400,
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'groupBy' },
      });
    },
  );
});

describe('query compilation depth and fan-out limits', () => {
  it('refuses objectSet and where nesting deeper than 64 levels without overflowing the stack', () => {
    let deepSet: Record<string, unknown> = { type: 'base', objectType: ENGAGEMENT };

    for (let i = 0; i < 80; i += 1) {
      deepSet = { type: 'filter', objectSet: deepSet, where: { type: 'and', value: [] } };
    }

    const compiledSet = settle(compileObjectSet(TEST_READER, deepSet, ontology, new DerivedUses()));

    expect(compiledSet.ok).toBe(false);

    const baseSet = settle(
      compileObjectSet(TEST_READER, { type: 'base', objectType: ENGAGEMENT }, ontology, new DerivedUses()),
    );

    if (!baseSet.ok) throw baseSet.error;

    let deepWhere: Record<string, unknown> = { type: 'and', value: [] };

    for (let i = 0; i < 80; i += 1) deepWhere = { type: 'not', value: deepWhere };

    const compiledWhere = settle(compileWhere(deepWhere, baseSet.value, new TextSearchBudget()));

    expect(compiledWhere.ok).toBe(false);
  });

  it('refuses selectV2 nesting deeper than 16 levels and rangesGroupBy with over 100 ranges', () => {
    let selector: Record<string, unknown> = { type: 'property', apiName: 'status' };

    for (let i = 0; i < 20; i += 1) selector = { type: 'propertyWithLoadLevel', propertyIdentifier: selector };

    const load = settle(
      readLoadObjectsRequest({
        objectSet: { type: 'base', objectType: ENGAGEMENT },
        selectV2: [selector],
      }),
    );

    expect(load.ok).toBe(false);

    const ranges = Array.from({ length: 101 }, (_, i) => ({ startValue: i, endValue: i + 1 }));

    const aggReq = settle(
      readAggregateRequest({
        objectSet: { type: 'base', objectType: ENGAGEMENT },
        groupBy: [{ type: 'ranges', field: 'hourlyRate', ranges }],
        aggregation: [{ type: 'count', name: 'count' }],
      }),
    );

    if (!aggReq.ok) throw aggReq.error;

    const baseSet = settle(compileObjectSet(TEST_READER, aggReq.value.objectSet, ontology, new DerivedUses()));

    if (!baseSet.ok) throw baseSet.error;

    const compiledAgg = settle(compileAggregation(aggReq.value, baseSet.value));

    expect(compiledAgg.ok).toBe(false);
  });

  it('bounds canonical bodyChecksum recursion on deeply nested extra fields', () => {
    let nested: Record<string, unknown> = { leaf: 1 };

    for (let i = 0; i < 200; i += 1) nested = { next: nested };

    expect(typeof bodyChecksum({ extra: nested })).toBe('string');
  });
});
