import { describe, expect, it } from 'vitest';
import { editBatchesSql } from './sql.ts';
import { checkValues } from './values.ts';
import { orThrow } from '../../errors/fallible.ts';
import type { CompiledOntology } from '../../ontology/index.ts';
import { NAMESPACE, objectType, ontology, property } from '../../publish/publish.test-utils.ts';
import { TEST_WRITER } from '../../service.test-utils.ts';

const ACCOUNT = `${NAMESPACE}Account`;

const account = {
  ...objectType(ACCOUNT, 'account', 'accountId', [property('accountId', 'account_id', { kind: 'string' }, true)]),
  joinTables: [
    { table: 'engagement_sponsors', columns: ['b_account_id'] },
    { table: 'account_partners', columns: ['a_account_id', 'b_account_id'] },
  ],
};

const view: CompiledOntology = ontology({ objectTypes: [account] });

describe('editBatchesSql on a narrowed view', () => {
  it('a delete clears the rows of each join table of the Object Type, also when the view holds no Link Type', () => {
    expect(view.linkTypes.size).toBe(0);

    const edits = orThrow(
      checkValues([{ type: 'deleteObject', object: { objectType: ACCOUNT, primaryKey: 'acc-1' } }], view, 'rules'),
    );

    expect(editBatchesSql(TEST_WRITER, view, edits).map((batch) => batch.sql)).toEqual([
      {
        text: [
          'WITH deleted AS (DELETE FROM "ontology_1_objects"."account" WHERE "account_id" = ANY($1::text[]) RETURNING 1 AS edited)',
          'link0 AS (DELETE FROM "ontology_1_objects"."engagement_sponsors" WHERE "b_account_id" = ANY($1::text[]))',
          'link1 AS (DELETE FROM "ontology_1_objects"."account_partners" WHERE "a_account_id" = ANY($1::text[]) OR "b_account_id" = ANY($1::text[])) SELECT edited FROM deleted',
        ].join(', '),
        values: [['acc-1']],
      },
    ]);
  });
});

describe('the create statement', () => {
  it('service/storage#writes: names the primary key column as the conflict target, because Postgres refuses a create with no target on a table with a deferrable constraint', () => {
    const edits = orThrow(
      checkValues(
        [{ type: 'addObject', object: { objectType: ACCOUNT, primaryKey: 'acc-1' }, properties: new Map() }],
        view,
        'rules',
      ),
    );

    const [batch] = editBatchesSql(TEST_WRITER, view, edits);

    expect(batch?.sql.text).toMatch(/ON CONFLICT \("account_id"\) DO NOTHING RETURNING 1 AS created$/);
  });
});
