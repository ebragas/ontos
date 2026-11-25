import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { withoutLinksOfDeleted } from '../actions/pure/rules.ts';
import { ApiError, settle } from '../errors/index.ts';
import { toEdits } from './edits.ts';

import { manyToManyLink, NS } from '../actions/actions.test-utils.ts';
import { compileOrThrow, stored, twinIr } from '../ontology/stored.test-utils.ts';
import { withFunctions } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

function baseIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  const sponsors = manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  );

  ir.ontology.linkTypes[sponsors.linkType.id] = sponsors;

  return ir;
}

const { ir, functions } = await withFunctions(
  [{ apiName: 'edit', inputs: [], edits: [ACCOUNT, ENGAGEMENT], links: ['engagementSponsors'] }],
  'export const functions = { edit: async () => [] };',
  baseIr(),
);

const ontology = compileOrThrow(stored(ir, { functions }));
const compiledEdit = ontology.functions.get('edit');

if (compiledEdit?.kind !== 'edit') throw new Error('The test Ontology has no edit Function edit.');

const fn = compiledEdit;

const account = (accountId: string) => ({ $apiName: ACCOUNT, $primaryKey: accountId });
const engagement = (engagementId: string) => ({ $apiName: ENGAGEMENT, $primaryKey: engagementId });

const link = (type: 'addLink' | 'removeLink', accountId: string, engagementId: string) => ({
  type,
  source: account(accountId),
  apiName: 'sponsoredEngagements',
  target: engagement(engagementId),
});

function applied(returned: unknown[]): unknown {
  const compiled = settle(toEdits(returned, ontology, fn));

  if (!compiled.ok) return `Error: ${(compiled.error.parameters as { message: string }).message}`;

  const kept = settle(withoutLinksOfDeleted(compiled.value));

  if (!kept.ok) return kept.error;

  return kept.value.map((edit) =>
    'object' in edit
      ? [edit.type, edit.object.primaryKey]
      : [edit.type, `${edit.source.primaryKey}-${edit.target.primaryKey}`],
  );
}

describe('a delete and the Link edits on its Object', () => {
  it('ontology/functions/edit-functions#apply: a Link edit before the delete is dropped, also when an update comes first', () => {
    const update = { type: 'updateObject', obj: account('acc-1'), properties: { name: 'n' } };
    const remove = { type: 'deleteObject', obj: account('acc-1') };

    expect(applied([update, link('removeLink', 'acc-1', 'eng-2'), remove])).toEqual([['deleteObject', 'acc-1']]);
    expect(applied([link('removeLink', 'acc-1', 'eng-2'), remove])).toEqual([['deleteObject', 'acc-1']]);
  });

  it('ontology/functions/edit-functions#apply: a create, a Link edit, and a delete of 1 Object leave no edit', () => {
    const create = {
      type: 'createObject',
      obj: { type: 'object', apiName: ACCOUNT },
      properties: { accountId: 'acc-9' },
    };

    expect(
      applied([create, link('addLink', 'acc-9', 'eng-1'), { type: 'deleteObject', obj: account('acc-9') }]),
    ).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: a Link edit after a create and a delete of its Object fails the Action', () => {
    const create = {
      type: 'createObject',
      obj: { type: 'object', apiName: ACCOUNT },
      properties: { accountId: 'acc-9' },
    };

    expect(thrown([create, { type: 'deleteObject', obj: account('acc-9') }, link('addLink', 'acc-9', 'eng-1')])).toBe(
      'FunctionExecutionFailed',
    );

    expect(applied([create, { type: 'deleteObject', obj: account('acc-9') }, link('addLink', 'acc-9', 'eng-1')])).toBe(
      `Error: The Function edits ${ACCOUNT} acc-9 after it deletes it.`,
    );
  });
});

describe('the Properties of an edit', () => {
  it('an edit of a Property that the Object Type does not have fails the Action as an edit that V1 does not allow', () => {
    expect(applied([{ type: 'updateObject', obj: account('acc-1'), properties: { nmae: 'n', $rid: 'ignored' } }])).toBe(
      `Error: An edit of ${ACCOUNT} names the Property nmae, which ${ACCOUNT} does not have.`,
    );
  });
});

describe('a delete and the Link edits on its target', () => {
  it('ontology/functions/edit-functions#apply: a create, a Link edit to it, and a delete of the target leave no edit', () => {
    const create = {
      type: 'createObject',
      obj: { type: 'object', apiName: ENGAGEMENT },
      properties: { engagementId: 'eng-9' },
    };

    expect(
      applied([create, link('addLink', 'acc-1', 'eng-9'), { type: 'deleteObject', obj: engagement('eng-9') }]),
    ).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: a delete keeps the earlier Link edits of other Objects', () => {
    expect(applied([link('addLink', 'acc-2', 'eng-1'), { type: 'deleteObject', obj: account('acc-1') }])).toEqual([
      ['addLink', 'acc-2-eng-1'],
      ['deleteObject', 'acc-1'],
    ]);
  });
});

const SEQUENCE = 'ontology/functions/edit-functions#apply';

const create = (accountId: string) => ({
  type: 'createObject',
  obj: { type: 'object', apiName: ACCOUNT },
  properties: { accountId, name: 'n' },
});

const update = (accountId: string) => ({ type: 'updateObject', obj: account(accountId), properties: { name: 'n' } });
const remove = (accountId: string) => ({ type: 'deleteObject', obj: account(accountId) });

function thrown(returned: unknown[]): unknown {
  const compiled = settle(toEdits(returned, ontology, fn));

  return !compiled.ok && compiled.error instanceof ApiError ? compiled.error.errorName : undefined;
}

describe('the order of the edits of 1 Object', () => {
  it.each([
    ['2 creates', [create('acc-new'), create('acc-new')]],
    ['a delete, then an update', [remove('acc-1'), update('acc-1')]],
    ['a delete, then a create', [remove('acc-1'), create('acc-1')]],
    ['an update, then a create', [update('acc-1'), create('acc-1')]],
  ])(`${SEQUENCE}: %s of 1 Object throws the refusal of an unsupported sequence`, (_name, returned) => {
    expect(thrown(returned)).toBe('ApplyActionFailed');
  });

  it.each([
    ['2 updates', [update('acc-1'), update('acc-1')], [['modifyObject', 'acc-1']]],
    ['a create, then an update', [create('acc-new'), update('acc-new')], [['addObject', 'acc-new']]],
    ['an update, then a delete', [update('acc-1'), remove('acc-1')], [['deleteObject', 'acc-1']]],
    ['a create, then a delete', [create('acc-new'), remove('acc-new')], []],
  ])('ontology/functions/edit-functions#apply: %s of 1 Object compile to 1 edit', (_name, returned, edits) => {
    expect(applied(returned)).toEqual(edits);
  });

  it('ontology/functions/edit-functions#apply: a delete after a delete, and an edit after a create and a delete, keep the refusal of an edit that V1 does not allow', () => {
    for (const returned of [
      [remove('acc-1'), remove('acc-1')],
      [create('acc-new'), remove('acc-new'), update('acc-new')],
      [create('acc-new'), remove('acc-new'), create('acc-new')],
    ]) {
      expect(thrown(returned)).toBe('FunctionExecutionFailed');
    }
  });

  it('ontology/functions/edit-functions#apply: the refused sequences on 2 different Objects compile', () => {
    expect(
      applied([
        create('acc-n1'),
        create('acc-n2'),
        remove('acc-3'),
        update('acc-1'),
        create('acc-n3'),
        remove('acc-2'),
        create('acc-n4'),
      ]),
    ).toEqual([
      ['addObject', 'acc-n1'],
      ['addObject', 'acc-n2'],
      ['deleteObject', 'acc-3'],
      ['modifyObject', 'acc-1'],
      ['addObject', 'acc-n3'],
      ['deleteObject', 'acc-2'],
      ['addObject', 'acc-n4'],
    ]);
  });

  it(`${SEQUENCE}: an update after a delete fails the Action`, () => {
    expect(thrown([remove('acc-1'), update('acc-1')])).toBe('ApplyActionFailed');
  });

  it(`${SEQUENCE}: a create after an update fails the Action`, () => {
    expect(thrown([update('acc-1'), create('acc-1')])).toBe('ApplyActionFailed');
  });
});

describe('the Object references of an edit', () => {
  it('a create with no String primary key fails the Action', () => {
    const create = { type: 'createObject', obj: { type: 'object', apiName: ACCOUNT }, properties: { accountId: 7 } };

    expect(applied([create])).toBe(`Error: A createObject edit of ${ACCOUNT} has no String primary key accountId.`);
  });

  it('a create with no Object Type definition fails the Action', () => {
    expect(applied([{ type: 'createObject', properties: { accountId: 'acc-1' } }])).toBe(
      'Error: An edit of the Function names the Object Type undefined, which the Ontology does not have.',
    );
  });

  it('an update with no Object reference fails the Action', () => {
    expect(applied([{ type: 'updateObject', properties: { name: 'n' } }])).toBe(
      'Error: An edit of the Function names the Object Type undefined, which the Ontology does not have.',
    );
  });

  it('an edit of an Object Type that the Ontology does not have fails the Action', () => {
    expect(applied([{ type: 'deleteObject', obj: { $apiName: `${NS}Invoice`, $primaryKey: 'inv-1' } }])).toBe(
      `Error: An edit of the Function names the Object Type ${NS}Invoice, which the Ontology does not have.`,
    );
  });

  it('ontology/functions/edit-functions#apply: an Object reference with no String $primaryKey fails the Action', () => {
    expect(applied([{ type: 'deleteObject', obj: { $apiName: ACCOUNT, $primaryKey: 7 } }])).toBe(
      `Error: An edit of the Function names an Object of ${ACCOUNT} with no String $primaryKey.`,
    );
  });

  it('a Link edit with no source fails the Action', () => {
    expect(applied([{ type: 'addLink', apiName: 'sponsoredEngagements', target: engagement('eng-1') }])).toBe(
      'Error: An edit of the Function names the Object Type undefined, which the Ontology does not have.',
    );
  });

  it('a Link edit of a Link that the source Object Type does not have fails the Action', () => {
    expect(
      applied([{ type: 'addLink', source: account('acc-1'), apiName: 'sponsors', target: engagement('eng-1') }]),
    ).toBe(`Error: A addLink edit names the Link sponsors, which ${ACCOUNT} does not have.`);
  });
});
