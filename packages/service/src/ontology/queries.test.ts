import { describe, expect, it } from 'vitest';
import { settle } from '../errors/index.ts';
import type { Ctx } from '../handler/index.ts';
import { ONTOLOGY_RID } from '../metadata.test-utils.ts';
import { emptyOntology, getQueryType, type CompiledOntology, type QueryFunction } from './index.ts';

const query: QueryFunction = {
  kind: 'query',
  apiName: 'amountLeft',
  rid: 'ri.function-registry.main.function.00000000-0000-5000-8000-000000000000',
  version: '3.0.0',
  parameters: new Map(),
  descriptions: new Map(),
  description: 'The amount left.',
  output: { type: { kind: 'decimal' }, optional: true },
};

describe('GET queryTypes/{queryApiName} on metadata of an older converter', () => {
  it('service/http-api#metadata-routes: a Query Function that the stored metadata does not list gets 404 QueryNotFound, as GET queryTypes lists none', async () => {
    const ontology: CompiledOntology = { ...emptyOntology(ONTOLOGY_RID), functions: new Map([[query.apiName, query]]) };
    const ctx = { ontology } as Ctx;

    const answer = await settle(
      getQueryType({ params: { queryApiName: query.apiName }, query: new URLSearchParams(), body: undefined }, ctx),
    );

    expect(answer.ok ? answer.value.status : [answer.error]).toEqual([
      expect.objectContaining({ status: 404, errorName: 'QueryNotFound', parameters: { query: 'amountLeft' } }),
    ]);
  });
});
