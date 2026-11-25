import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountWith, irOf, stringProperty } from '../ontology/stored.test-utils.ts';
import { insertObjects, NS, startObjectSets, type ObjectSetsService } from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const ACCOUNTS = [
  { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
  { accountId: 'acc-2', name: 'Globex', phase: 'prospect' },
  { accountId: 'acc-3', name: 'Initech', phase: 'closed' },
];

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(irOf(accountWith(stringProperty('note'))));

  await insertObjects(service.db, ACCOUNT, ACCOUNTS);
});

afterAll(() => service?.stop());

describe('a type with no policy shows each Object, as today', () => {
  it('loadObjects, a set operation, and a count give each Object of a type with no object security policy', async () => {
    const base = { type: 'base', objectType: ACCOUNT };

    const loaded = await service.loadObjects({
      objectSet: base,
      select: ['accountId'],
      orderBy: { fields: [{ field: 'accountId' }] },
      excludeRid: true,
    });

    expect(loaded).toMatchObject({
      status: 200,
      body: { data: ACCOUNTS.map(({ accountId }) => ({ accountId })), totalCount: '3' },
    });

    const union = await service.loadObjects({
      objectSet: { type: 'union', objectSets: [base, base] },
      select: ['accountId'],
      excludeRid: true,
    });

    expect((union.body as { totalCount: string }).totalCount).toBe('3');

    const counted = await service.aggregate({
      objectSet: base,
      groupBy: [],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expect(counted).toEqual({
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'count', value: 3 }] }] },
    });
  });
});
