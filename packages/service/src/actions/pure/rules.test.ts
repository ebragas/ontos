import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../objects.ts';
import { runRules } from './rules.ts';
import { orThrow } from '../../errors/fallible.ts';
import {
  type JsonValue,
  type ParameterId,
  type PropertyApiName,
  type Rule,
  type RuleValue,
} from '../../ontology/index.ts';
import { compileOrThrow, stored, twinFunctions, twinIr } from '../../ontology/stored.test-utils.ts';
import { NS } from '../actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ontology = compileOrThrow(stored(twinIr('0.6.3'), { functions: twinFunctions('0.6.3') }));

const account = (primaryKey: string): LoadedObject => ({
  objectType: ACCOUNT,
  primaryKey,
  version: '1',
  properties: new Map(),
});

const id = (name: string) => name as ParameterId;

const addLink = (source: string, target: string): Rule => ({
  kind: 'addLink',
  link: 'link',
  source: id(source),
  target: id(target),
});

const values = (entries: Record<string, RuleValue>) =>
  new Map(Object.entries(entries)) as ReadonlyMap<PropertyApiName, RuleValue>;

const createAccount = (primaryKey: string): Rule => ({
  kind: 'addObject',
  objectType: ACCOUNT,
  properties: values({ accountId: { kind: 'static', value: primaryKey } }),
});

const modify = (object: string, properties: Record<string, RuleValue> = {}): Rule => ({
  kind: 'modifyObject',
  object: id(object),
  properties: values(properties),
});

const remove = (object: string): Rule => ({ kind: 'deleteObject', object: id(object) });

function run(rules: Rule[], parameters: Record<string, JsonValue> = {}) {
  const objects = new Map<ParameterId, LoadedObject>(
    ['a', 'b', 'c', 'x', 'y', 'z'].map((name) => [id(name), account(name)]),
  );

  return orThrow(
    runRules({ kind: 'rules', rules }, ontology, {
      parameters: new Map(Object.entries(parameters)) as Map<ParameterId, JsonValue>,
      omittedDefaults: new Map(),
      objects,
      now: '2026-10-26T00:00:00.000Z',
      user: 'user',
    }),
  );
}

function edits(rules: Rule[]): unknown {
  return run(rules).map((edit) =>
    'object' in edit
      ? [edit.type, edit.object.primaryKey]
      : [edit.type, `${edit.source.primaryKey}-${edit.target.primaryKey}`],
  );
}

function propertiesOf(rules: Rule[], parameters: Record<string, JsonValue> = {}): unknown {
  const [edit] = run(rules, parameters);

  return edit && 'properties' in edit ? Object.fromEntries(edit.properties) : edit;
}

const REFUSED = expect.objectContaining({ status: 400, errorName: 'ApplyActionFailed' });

describe('the refusal of rules that do not compile to 1 edit for each Object', () => {
  it.each([
    ['creates an Object and then changes it', [createAccount('a'), modify('a')]],
    ['creates an Object and then deletes it', [createAccount('a'), remove('a')]],
    ['deletes an Object and then changes it', [remove('a'), modify('a')]],
    ['deletes an Object twice', [remove('a'), remove('a')]],
    ['deletes an Object and then links it as the source', [remove('a'), addLink('a', 'x')]],
    ['deletes an Object and then links it as the target', [remove('x'), addLink('a', 'x')]],
  ])('refuses an Action that %s', (_, rules) => {
    expect(() => run(rules)).toThrow(REFUSED);
  });

  it('gives no edit for a change or a delete whose Object parameter has no Object', () => {
    expect(edits([modify('none'), remove('none')])).toEqual([]);
  });

  it('applies a change after a change of the same Object as 1 edit', () => {
    expect(edits([modify('a'), modify('a')])).toEqual([['modifyObject', 'a']]);
  });
});

describe('a Link rule', () => {
  it('gives no edit when its source or its target parameter has no Object', () => {
    expect(edits([addLink('a', 'none'), addLink('none', 'x'), addLink('a', 'x')])).toEqual([['addLink', 'a-x']]);
  });

  it('gives 1 edit for each rule, also for 2 rules with the same source and target', () => {
    expect(edits([addLink('a', 'x'), addLink('a', 'x'), addLink('b', 'y')])).toEqual([
      ['addLink', 'a-x'],
      ['addLink', 'a-x'],
      ['addLink', 'b-y'],
    ]);
  });
});

describe('the rule values', () => {
  it('keeps a falsy parameter value, and does not change it to the empty value', () => {
    const amount: RuleValue = { kind: 'parameter', parameter: id('amount') };

    const create: Rule = {
      kind: 'addObject',
      objectType: ENGAGEMENT,
      properties: values({ engagementId: { kind: 'static', value: 'eng-1' }, amount }),
    };

    expect(propertiesOf([create], { amount: 0 })).toEqual({ amount: 0 });

    expect(propertiesOf([modify('a', { name: { kind: 'parameter', parameter: id('name') } })], { name: '' })).toEqual({
      name: '',
    });
  });

  it('gives no value for a Property of an Object parameter that has no Object', () => {
    expect(
      propertiesOf([
        modify('a', { name: { kind: 'objectProperty', parameter: id('none'), property: 'name' as PropertyApiName } }),
      ]),
    ).toEqual({ name: null });
  });
});

describe('a delete and the Link edits of the rules', () => {
  it('drops only the earlier Link edits on its Object, and keeps each later Link edit', () => {
    const rules: Rule[] = [addLink('a', 'x'), modify('x'), addLink('b', 'y'), remove('x'), addLink('c', 'z')];

    expect(edits(rules)).toEqual([
      ['deleteObject', 'x'],
      ['addLink', 'b-y'],
      ['addLink', 'c-z'],
    ]);
  });
});

describe('the default value of an omitted parameter', () => {
  type DefaultValue = {
    readonly kind: 'objectProperty';
    readonly parameter: ParameterId;
    readonly property: PropertyApiName;
  };

  const defaultValue = (parameter: string, property: string): DefaultValue => ({
    kind: 'objectProperty',
    parameter: id(parameter),
    property,
  });

  const objects = new Map<ParameterId, LoadedObject>([
    [id('a'), account('a')],
    [
      id('x'),
      {
        objectType: ACCOUNT,
        primaryKey: 'x',
        version: '1',
        properties: new Map<string, JsonValue>([
          ['phase', 'customer'],
          ['name', 'Acme'],
        ]),
      },
    ],
    [
      id('s'),
      {
        objectType: `${NS}StructProbe`,
        primaryKey: 's',
        version: '1',
        properties: new Map<string, JsonValue>([['relationship', { label: 'old' }]]),
      },
    ],
  ]);

  const runWith = (rules: Rule[], defaults: Record<string, DefaultValue>) =>
    orThrow(
      runRules({ kind: 'rules', rules }, ontology, {
        parameters: new Map(),
        omittedDefaults: new Map(Object.entries(defaults)) as Map<ParameterId, DefaultValue>,
        objects,
        now: '2026-10-26T00:00:00.000Z',
        user: 'user',
      }),
    );

  const propertiesWith = (rules: Rule[], defaults: Record<string, DefaultValue>) =>
    runWith(rules, defaults).map((edit) => ('properties' in edit ? Object.fromEntries(edit.properties) : edit.type));

  it('ontology/action-types/rules#values: a default value that reads another Property gives its value', () => {
    expect(
      propertiesWith([modify('x', { phase: { kind: 'parameter', parameter: id('p') } })], {
        p: defaultValue('x', 'name'),
      }),
    ).toEqual([{ phase: 'Acme' }]);
  });

  it('ontology/action-types/rules#values: a default value that reads the Property of another Object parameter gives its value, also when the Property is the same', () => {
    expect(
      propertiesWith([modify('a', { phase: { kind: 'parameter', parameter: id('p') } })], {
        p: defaultValue('x', 'phase'),
      }),
    ).toEqual([{ phase: 'customer' }]);
  });

  it('ontology/action-types/rules#values: a default value that is the Property of the modified Object keeps it, and the edit has no value for it', () => {
    expect(
      propertiesWith([modify('x', { phase: { kind: 'parameter', parameter: id('p') } })], {
        p: defaultValue('x', 'phase'),
      }),
    ).toEqual([{}]);
  });

  it('ontology/action-types/rules#values: a create takes the default value', () => {
    const create: Rule = {
      kind: 'addObject',
      objectType: ACCOUNT,
      properties: values({
        accountId: { kind: 'static', value: 'new' },
        phase: { kind: 'parameter', parameter: id('p') },
      }),
    };

    expect(propertiesWith([create], { p: defaultValue('x', 'phase') })).toEqual([{ phase: 'customer' }]);
  });

  it('ontology/action-types/rules#values: a struct parameter with a default value keeps its own struct Property, and gives the value of another', () => {
    const structModify = (object: string): Rule => ({
      kind: 'modifyObject',
      object: id(object),
      properties: values({ relationship: { kind: 'structParameter', parameter: id('r') } }),
    });

    expect(propertiesWith([structModify('s')], { r: defaultValue('s', 'relationship') })).toEqual([{}]);

    const other: LoadedObject = {
      objectType: `${NS}StructProbe`,
      primaryKey: 't',
      version: '1',
      properties: new Map(),
    };

    objects.set(id('t'), other);

    expect(propertiesWith([structModify('t')], { r: defaultValue('s', 'relationship') })).toEqual([
      { relationship: { label: 'old' } },
    ]);

    objects.delete(id('t'));
  });
});
