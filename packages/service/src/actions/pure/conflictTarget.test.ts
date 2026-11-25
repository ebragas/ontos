import { describe, expect, it } from 'vitest';
import { editBatchesSql } from './sql.ts';
import { checkValues } from './values.ts';
import { orThrow } from '../../errors/fallible.ts';
import { NAMESPACE, objectType, ontology, property } from '../../publish/publish.test-utils.ts';
import { TEST_WRITER } from '../../service.test-utils.ts';

const INVOICE = `${NAMESPACE}Invoice`;

const invoice = objectType(INVOICE, 'invoice', 'invoiceId', [
  property('invoiceId', 'invoice_id', { kind: 'string' }, true),
  property('number', 'number', { kind: 'string' }),
]);

const view = ontology({ objectTypes: [invoice] });

describe('the SQL builders of an Object table', () => {
  it('service/storage#writes: each INSERT of an addObject edit names the primary key column in ON CONFLICT ("<primary key>") DO NOTHING', () => {
    const edits = orThrow(
      checkValues(
        [
          {
            type: 'addObject',
            object: { objectType: INVOICE, primaryKey: 'inv-1' },
            properties: new Map([['number', 'INV-1']]),
          },
        ],
        view,
        'rules',
      ),
    );

    for (const batch of editBatchesSql(TEST_WRITER, view, edits)) {
      const { text } = batch.sql;
      const targetless = /ON CONFLICT DO NOTHING/.test(text);

      expect(
        targetless,
        `An INSERT into an Object table needs the primary key target, ON CONFLICT ("invoice_id") DO NOTHING. Got: ${text}`,
      ).toBe(false);

      expect(text).toContain('ON CONFLICT ("invoice_id") DO NOTHING');
    }
  });
});
