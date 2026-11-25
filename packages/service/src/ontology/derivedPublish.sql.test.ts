import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import type { ObjectTypeFullMetadata, ObjectTypeV2 } from '@osdk/foundry.ontologies';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONTOLOGY_RID, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { columnsOf } from '../publish/publish.test-utils.ts';

import { compileOrThrow, NS, stored } from './stored.test-utils.ts';

const ir = JSON.parse(readFileSync(new URL('../../twin/ir/derived.json', import.meta.url), 'utf8')) as OntologyIr;
const compiled = compileOrThrow(stored(ir));
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const ACCOUNT = `${NS}Account`;
const TRANSACTION = `${NS}Transaction`;

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(ir);
});

afterAll(async () => {
  await service.stop();
});

async function get<T>(path: string): Promise<T> {
  const answer = await service.call('GET', `${ONTOLOGY}/${path}`);

  if (answer.status !== 200) throw new Error(`GET ${path} gave ${answer.status}: ${answer.text}`);

  return JSON.parse(answer.text) as T;
}

describe('ontology/object-link-types/derived-properties#publish', () => {
  it('ontology/object-link-types/derived-properties#publish: the table of each Object Type has a column for each stored Property, and none for a derived Property', async () => {
    for (const objectType of compiled.objectTypes.values()) {
      const columns = (await columnsOf(service.db, objectType.table))
        .map((column) => column.column_name)
        .filter((name) => !name.startsWith('__'));

      expect({ objectType: objectType.apiName, columns: columns.sort() }).toEqual({
        objectType: objectType.apiName,
        columns: [...objectType.properties.values()].map((property) => property.column).sort(),
      });
    }

    const derived = [...compiled.objectTypes.values()].flatMap((objectType) => [...objectType.derived.keys()]);

    expect(derived.sort()).toEqual([
      'accountEntity',
      'assignmentCount',
      'balance',
      'categoryEntity',
      'invoiceAccount',
      'invoiceCount',
    ]);
  });
});

describe('ontology/object-link-types/derived-properties#ontology-metadata', () => {
  it('ontology/object-link-types/derived-properties#ontology-metadata: fullMetadata gives each derived Property as a plain Property of its declared type, and 1 unsupported datasource', async () => {
    const metadata = await get<{ objectTypes: Record<string, ObjectTypeFullMetadata> }>('fullMetadata');

    const account = metadata.objectTypes[ACCOUNT]?.objectType;

    expect(account?.properties['balance']).toEqual({
      displayName: 'Balance',
      dataType: { type: 'decimal', precision: 14, scale: 2 },
      rid: compiled.objectTypes.get(ACCOUNT)?.derived.get('balance')?.rid,
      status: { type: 'active' },
      visibility: 'NORMAL',
      typeClasses: [
        { kind: 'render_hint', name: 'SELECTABLE' },
        { kind: 'render_hint', name: 'SORTABLE' },
      ],
    });

    expect(account?.properties['balance']).not.toHaveProperty('valueTypeApiName');

    expect(account?.datasources).toEqual([
      {
        rid: expect.stringMatching(/^ri\.ontology\.main\.datasource\./) as unknown,
        definition: { type: 'unsupported', unsupportedType: 'derived', properties: ['balance'] },
      },
    ]);

    const transaction = metadata.objectTypes[TRANSACTION]?.objectType;

    expect(transaction?.properties['categoryEntity']?.dataType).toEqual({ type: 'string' });

    expect(transaction?.datasources.map((datasource) => datasource.definition)).toEqual([
      { type: 'unsupported', unsupportedType: 'derived', properties: ['categoryEntity', 'accountEntity'] },
    ]);

    expect(metadata.objectTypes[`${NS}Category`]?.objectType.datasources).toEqual([]);
    expect(JSON.stringify(metadata)).not.toMatch(/"selection"|"searchAround"|aggregatedProperties|linkedProperties/);
  });

  it('ontology/object-link-types/derived-properties#ontology-metadata: the Object Type route gives the same derived Property and datasource', async () => {
    const account = await get<ObjectTypeV2>(`objectTypes/${ACCOUNT}`);

    expect(account.properties['balance']?.dataType).toEqual({ type: 'decimal', precision: 14, scale: 2 });

    expect(account.datasources.map((datasource) => datasource.definition)).toEqual([
      { type: 'unsupported', unsupportedType: 'derived', properties: ['balance'] },
    ]);

    const role = await get<ObjectTypeV2>(`objectTypes/${NS}Role`);

    expect(role.properties['assignmentCount']?.dataType).toEqual({ type: 'integer' });
  });
});
