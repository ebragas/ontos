import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import type { Edit } from '../index.ts';
import { historyEntries } from './entries.ts';
import { checkValues } from './values.ts';
import { orThrow } from '../../errors/fallible.ts';

import { compileOrThrow, NS, stored, twinFunctions, twinIr, unchecked } from '../../ontology/stored.test-utils.ts';

const STRUCT_PROBE = `${NS}StructProbe`;

const ACTION = {
  operationId: 'ri.actions.main.action.00000000-0000-4000-8000-000000000000',
  actionTypeRid: 'ri.actions.main.action-type.test',
  userId: 'user',
};

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');
  const block = ir.ontology.objectTypes[STRUCT_PROBE];

  if (!block) throw new Error('The twin 0.6.3 IR has no StructProbe.');

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: STRUCT_PROBE, storeAllPreviousProperties: false } },
  });

  return ir;
}

const ontology = compileOrThrow(stored(testIr(), { functions: twinFunctions('0.6.3') }));

function entryEdit(edit: Edit): unknown {
  const [entry] = historyEntries(
    orThrow(checkValues([edit], ontology, 'rules')),
    ontology,
    ACTION,
    () => new Map([['relationship', { label: 'old' }]]),
  );

  return (entry?.entry as { edit: unknown } | undefined)?.edit;
}

const SP_1 = { objectType: STRUCT_PROBE, primaryKey: 'sp-1' };
const RELATIONSHIP = new Map([['relationship', { label: 'met', since: null }]]);

describe('a struct value in an entry', () => {
  it('ontology/object-edits/edit-history#entries, ontology/object-link-types/properties#structs: a modify holds a struct value with no key for a field with no value', () => {
    expect(entryEdit({ type: 'modifyObject', object: SP_1, properties: RELATIONSHIP })).toEqual({
      type: 'modifyEdit',
      properties: { relationship: { label: 'met' } },
      previousProperties: { relationship: { label: 'old' } },
      includesAllPreviousValues: false,
    });
  });

  it('ontology/object-edits/edit-history#entries, ontology/object-link-types/properties#structs: a create holds a struct value with no key for a field with no value', () => {
    expect(entryEdit({ type: 'addObject', object: SP_1, properties: RELATIONSHIP })).toEqual({
      type: 'createEdit',
      properties: { probeId: 'sp-1', relationship: { label: 'met' } },
    });
  });
});
