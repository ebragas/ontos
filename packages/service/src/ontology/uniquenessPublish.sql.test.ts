import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import type { ObjectTypeFullMetadata, ObjectTypeV2 } from '@osdk/foundry.ontologies';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONTOLOGY_RID, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { NS } from './stored.test-utils.ts';

const ir = JSON.parse(readFileSync(new URL('../../twin/ir/uniqueness.json', import.meta.url), 'utf8')) as OntologyIr;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const INVOICE = `${NS}Invoice`;
const MEMBERSHIP = `${NS}Membership`;

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

describe('the constraint of each rule of the IR', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: the publish creates 1 deferred unique constraint per rule, with the Postgres name of the rule and its columns in API name order', async () => {
    const rows = await service.db.query<{ table: string; name: string; definition: string }>(
      sql(
        "SELECT conrelid::regclass::text AS table, conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype = 'u' AND connamespace = 'ontology_1_objects'::regnamespace ORDER BY 1, 2",
      ),
    );

    expect(rows).toEqual([
      {
        table: 'ontology_1_objects.invoice',
        name: 'unique_invoice_invoiceNumber_b8767274',
        definition: 'UNIQUE (number) DEFERRABLE INITIALLY DEFERRED',
      },
      {
        table: 'ontology_1_objects.invoice',
        name: 'unique_invoice_numberPerYear_20dc6ae5',
        definition: 'UNIQUE (number, year) DEFERRABLE INITIALLY DEFERRED',
      },
      {
        table: 'ontology_1_objects.membership',
        name: 'unique_membership_onePersonPerRole_74903fac',
        definition: 'UNIQUE (person_id, role_id) DEFERRABLE INITIALLY DEFERRED',
      },
    ]);
  });
});

describe('the type classes of a rule in the Ontology metadata', () => {
  it('ontology/object-link-types/properties#type-classes: fullMetadata gives each unique type class unchanged in typeClasses', async () => {
    const metadata = await get<{ objectTypes: Record<string, ObjectTypeFullMetadata> }>('fullMetadata');

    const invoice = metadata.objectTypes[INVOICE]?.objectType.properties;

    expect(invoice?.['number']?.typeClasses).toEqual([
      { kind: 'unique', name: 'invoiceNumber' },
      { kind: 'unique', name: 'numberPerYear' },
    ]);

    expect(invoice?.['year']?.typeClasses).toEqual([{ kind: 'unique', name: 'numberPerYear' }]);

    const membership = metadata.objectTypes[MEMBERSHIP]?.objectType.properties;

    expect(membership?.['roleId']?.typeClasses).toEqual([{ kind: 'unique', name: 'onePersonPerRole' }]);
    expect(membership?.['personId']?.typeClasses).toEqual([{ kind: 'unique', name: 'onePersonPerRole' }]);
  });

  it('ontology/object-link-types/properties#type-classes: the Object Type route gives the same type classes', async () => {
    const membership = await get<ObjectTypeV2>(`objectTypes/${MEMBERSHIP}`);

    expect(membership.properties['personId']?.typeClasses).toEqual([{ kind: 'unique', name: 'onePersonPerRole' }]);
  });
});
