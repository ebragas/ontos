import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { NS, twinFunctions, twinIr } from './stored.test-utils.ts';
import { asJson, convertTwin, ONTOLOGY_RID, startMetadata, type MetadataService } from '../metadata.test-utils.ts';

let service: MetadataService;

beforeAll(async () => {
  service = await startMetadata(twinIr('0.4.0'), twinFunctions('0.4.0'), 'staging');
});

afterAll(async () => {
  await service.stop();
});

describe('GET fullMetadata', () => {
  it('the route in the environment staging serves the same metadata, with the same RIDs, as the converter output of the twin with no environment', async () => {
    const answer = await service.get('fullMetadata');

    const { metadata } = convertTwin('0.4.0');

    expect(answer).toEqual({
      status: 200,
      body: asJson({
        ...metadata,
        ontology: { rid: ONTOLOGY_RID, apiName: 'twin', displayName: 'twin', description: '' },
      }),
    });

    const body = answer.body as OntologyFullMetadata;

    expect(body.objectTypes[`${NS}Account`]?.objectType.rid).toBe(
      'ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd',
    );

    expect(body.objectTypes[`${NS}Account`]?.linkTypes.map((side) => side.linkTypeRid)).toEqual([
      'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f',
    ]);

    expect(body.actionTypes[`${NS}close-account-action`]?.rid).toBe(
      'ri.actions.main.action-type.c2e94fe7-721f-5e98-b0c8-ea8acb3e93e0',
    );
  });

  it('the ontology block of the route has the Ontology RID of the settings', async () => {
    const answer = await service.get('fullMetadata');

    expect((answer.body as { ontology: { rid: string } }).ontology.rid).toBe(ONTOLOGY_RID);
  });
});
