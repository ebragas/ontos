import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimsOf, NO_ROLE } from './people.test-utils.ts';
import { unchecked } from './ontology/stored.test-utils.ts';
import {
  startActions,
  NS,
  ONTOLOGY_RID,
  type ActionsService,
  type RawAnswer,
  type SendOptions,
} from './actions/actions.test-utils.ts';
import type { GrantsFile } from './ontology/index.ts';
import { readFileSync } from 'node:fs';

const SECTION = 'ontology/object-link-types/value-types#ontology-metadata';
const TASK = `${NS}Task`;
const NOTE = `${NS}Note`;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;

const VALUE_TYPE_RID =
  /^ri\.type-registry\.main\.value-type\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ADMIN: SendOptions = { claims: claimsOf('admin') };
const MEMBER: SendOptions = { claims: claimsOf('member') };
const NO_ROLE_PERSON: SendOptions = { claims: { sub: NO_ROLE } };

type Json = Record<string, any>; // oxlint-disable-line typescript/no-explicit-any -- the test reads a JSON answer by path.

function without<T>(properties: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(properties).filter(([name]) => name !== 'budget' && name !== 'labels'));
}

function valueTypesIr(): OntologyIr {
  const ir = JSON.parse(readFileSync(new URL('../twin/ir/value-types.json', import.meta.url), 'utf8')) as OntologyIr;
  const task = ir.ontology.objectTypes[TASK];

  if (!task) throw new Error('The value types IR has no Object Type Task.');

  const note = structuredClone(task);

  note.objectType.apiName = NOTE;

  note.objectType.displayMetadata = {
    ...note.objectType.displayMetadata,
    displayName: 'Note',
    pluralDisplayName: 'Notes',
  };

  note.objectType.propertyTypes = without(note.objectType.propertyTypes);

  const source = unchecked<{ datasetV2: { datasetRid: string; propertyMapping: Record<string, unknown> } }>(
    note.datasources[0]?.datasource,
  );

  source.datasetV2.datasetRid = NOTE;
  source.datasetV2.propertyMapping = without(source.datasetV2.propertyMapping);

  ir.ontology.objectTypes[NOTE] = note;

  return ir;
}

const grants: GrantsFile = {
  permissions: { 'twin:use': { description: 'Use the twin' }, 'twin:admin': { description: 'Administer the twin' } },
  objectTypes: { [TASK]: 'twin:admin', [NOTE]: 'twin:use' },
  actionTypes: {},
  defaultRoles: { admin: ['twin:use', 'twin:admin'], member: ['twin:use'] },
};

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(valueTypesIr(), undefined, grants);
});

afterAll(() => service?.stop());

async function metadata(options: SendOptions): Promise<{ raw: RawAnswer; body: Json }> {
  const raw = await service.call('GET', `${ONTOLOGY}/fullMetadata`, undefined, options);

  expect(raw.status).toBe(200);

  return { raw, body: JSON.parse(raw.text) as Json };
}

describe('fullMetadata', () => {
  it(`${SECTION}: gives each value type that a Property uses, in the shape of OntologyValueType, and each such Property gives valueTypeApiName`, async () => {
    const { body } = await metadata(ADMIN);

    expect(Object.keys(body['valueTypes']).sort()).toEqual(['money', 'tags', 'taskStatus']);

    expect(body['valueTypes']['taskStatus']).toEqual({
      apiName: 'taskStatus',
      displayName: 'Task status',
      rid: expect.stringMatching(VALUE_TYPE_RID),
      status: 'ACTIVE',
      fieldType: { type: 'string' },
      version: '1.1.0',
      constraints: [{ type: 'enum', options: ['open', 'done'] }],
    });

    expect(body['valueTypes']['money']).toEqual({
      apiName: 'money',
      displayName: 'Money',
      description: 'An amount from 0 to 1000000.',
      rid: expect.stringMatching(VALUE_TYPE_RID),
      status: 'DEPRECATED',
      fieldType: { type: 'decimal' },
      version: '1.0.0',
      constraints: [{ type: 'range', minimumValue: '0', maximumValue: '1000000' }],
    });

    expect(body['valueTypes']['tags']).toMatchObject({
      status: 'ACTIVE',
      fieldType: { type: 'array', subType: { type: 'string' } },
      version: '2.0.0',
    });

    expect(body['valueTypes']['tags']['constraints']).toEqual([
      {
        type: 'array',
        minimumSize: 1,
        maximumSize: 5,
        uniqueValues: true,
        valueConstraint: { type: 'regex', pattern: '[a-z]+', partialMatch: false },
      },
    ]);

    const properties = body['objectTypes'][TASK]['objectType']['properties'];

    expect(
      Object.fromEntries(
        Object.entries<Json>(properties).map(([name, property]) => [name, property['valueTypeApiName']]),
      ),
    ).toEqual({ taskId: undefined, status: 'taskStatus', budget: 'money', labels: 'tags' });
  });

  it(`${SECTION}: gives a Decimal bound as an exact string, and no Decimal as a JSON number`, async () => {
    const { raw } = await metadata(ADMIN);

    expect(raw.text).toContain('"maximumValue":"1000000"');
    expect(raw.text).toContain('"minimumValue":"0"');
    expect(raw.text).not.toMatch(/"(?:minimum|maximum)Value":\d/);
  });

  it(`${SECTION}: gives no failure message, because API v2 has none`, async () => {
    const { raw } = await metadata(ADMIN);

    expect(raw.text).not.toContain('Use open or done');
    expect(raw.text).not.toContain('failureMessage');
  });

  it(`${SECTION}: gives a caller who cannot see an Object Type no value type that only its Properties use`, async () => {
    const { body } = await metadata(MEMBER);

    expect(Object.keys(body['objectTypes'])).toEqual([NOTE]);
    expect(Object.keys(body['valueTypes'])).toEqual(['taskStatus']);
    expect(body['objectTypes'][NOTE]['objectType']['properties']['status']['valueTypeApiName']).toBe('taskStatus');
  });

  it(`${SECTION}: gives a caller who sees no Object Type no value type`, async () => {
    const { body } = await metadata(NO_ROLE_PERSON);

    expect(body['objectTypes']).toEqual({});
    expect(body['valueTypes']).toEqual({});
  });
});
