import type { ActionTypeV2, QueryTypeV2 } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { orThrow } from '../errors/fallible.ts';
import type { Ctx } from '../handler/index.ts';
import { ONTOLOGY_RID } from '../metadata.test-utils.ts';
import { emptyOntology, listActionTypes, listQueryTypes } from './index.ts';

const names = Array.from({ length: 501 }, (_, index) => `ai.test.action-${String(index).padStart(3, '0')}`);
const empty = emptyOntology(ONTOLOGY_RID);

const ctx = {
  ontology: {
    ...empty,
    metadata: {
      ...empty.metadata,
      actionTypes: Object.fromEntries(names.map((apiName) => [apiName, { apiName } as ActionTypeV2])),
    },
  },
} as Ctx;

async function list(query: string): Promise<{ data: ActionTypeV2[]; nextPageToken?: string }> {
  const response = await orThrow(
    listActionTypes({ params: {}, query: new URLSearchParams(query), body: undefined }, ctx),
  );

  return (await response.json()) as { data: ActionTypeV2[]; nextPageToken?: string };
}

describe('GET actionTypes on 501 Action Types', () => {
  it('service/http-api#metadata-routes: the default and the maximum pageSize are 500', async () => {
    for (const query of ['', 'pageSize=1000']) {
      const first = await list(query);

      expect(first.data.map((entry) => entry.apiName)).toEqual(names.slice(0, 500));
      expect(first.nextPageToken).toBeDefined();

      const next = await list(`${query}&pageToken=${first.nextPageToken}`);

      expect(next).toEqual({ data: [{ apiName: names[500] }] });
    }
  });
});

describe('GET queryTypes on 101 Query Functions', () => {
  const queries = Array.from({ length: 101 }, (_, index) => `query${String(index).padStart(3, '0')}`);

  const queryCtx = {
    ontology: {
      ...empty,
      metadata: {
        ...empty.metadata,
        queryTypes: Object.fromEntries(queries.map((apiName) => [apiName, { apiName } as QueryTypeV2])),
      },
    },
  } as Ctx;

  it('service/http-api#metadata-routes: the default and the maximum pageSize are 100', async () => {
    const page = async (query: string) =>
      (await (
        await orThrow(listQueryTypes({ params: {}, query: new URLSearchParams(query), body: undefined }, queryCtx))
      ).json()) as { data: QueryTypeV2[]; nextPageToken?: string };

    for (const query of ['', 'pageSize=500']) {
      const first = await page(query);

      expect(first.data.map((entry) => entry.apiName)).toEqual(queries.slice(0, 100));

      expect(await page(`${query}&pageToken=${first.nextPageToken}`)).toEqual({ data: [{ apiName: queries[100] }] });
    }
  });
});
