import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import {
  type CompiledActionType,
  type CompiledOntology,
  type EditFunction,
  publishedActionTypeNames,
  type StoredOntologyVersion,
} from './index.ts';
import type { DiscoveredDataType, DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import {
  compileOrThrow,
  expectFeatureRefused,
  expectRefused,
  NS,
  propertyOfType,
  stored,
  STRING_FLAGS,
  twinFunctions,
  twinIr,
  type TwinVersion,
  unchecked,
} from './stored.test-utils.ts';

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

type LinkTypeBlock = OntologyIr['ontology']['linkTypes'][string];

type ValidationBlock = ActionTypeBlock['actionType']['actionTypeLogic']['validation']['parameterValidations'][string];

type IrParameterType = ActionTypeBlock['actionType']['metadata']['parameters'][string]['type'];

type IrRule = ActionTypeBlock['actionType']['actionTypeLogic']['logic']['rules'][number];

type IrCondition =
  ActionTypeBlock['actionType']['actionTypeLogic']['validation']['actionTypeLevelValidation']['rules'][number]['condition'];

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
const SET_RELATIONSHIP_ACTION = `${NS}set-relationship-action`;

function compiledActionType(compiled: CompiledOntology, apiName: string): CompiledActionType {
  const actionType = compiled.actionTypes.get(apiName);

  if (!actionType) throw new Error(`compileOntology gave no Action Type ${apiName}.`);

  return actionType;
}

function twinActionType(version: TwinVersion, name: string): ActionTypeBlock {
  const block = twinIr(version).ontology.actionTypes[`${NS}${name}`];

  if (!block) throw new Error(`The twin ${version} IR has no Action Type ${name}.`);

  return structuredClone(block);
}

function irWithActions(version: TwinVersion, ...blocks: ActionTypeBlock[]): OntologyIr {
  const ir = twinIr(version);

  ir.ontology.actionTypes = Object.fromEntries(blocks.map((b) => [b.actionType.metadata.apiName, b]));

  if (ir.ontology.blockPermissionInformation) ir.ontology.blockPermissionInformation.actionTypes = {};

  return ir;
}

function renamed(block: ActionTypeBlock, apiName: string): ActionTypeBlock {
  block.actionType.metadata.apiName = apiName;

  return block;
}

function validationBlock(allowedValues: unknown, required = false): ValidationBlock {
  return unchecked<ValidationBlock>({
    defaultValidation: {
      display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
      validation: {
        allowedValues,
        required: required ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
      },
    },
    conditionalOverrides: [],
  });
}

function withParameter(block: ActionTypeBlock, id: string, type: unknown, allowedValues: unknown): ActionTypeBlock {
  const { metadata, actionTypeLogic } = block.actionType;

  metadata.parameters[id] = unchecked({
    id,
    type,
    displayMetadata: { displayName: id, description: '', typeClasses: [] },
  });

  metadata.parameterOrdering.push(id);

  actionTypeLogic.validation.parameterValidations[id] = validationBlock(allowedValues);

  return block;
}

function validationOf(block: ActionTypeBlock, id: string): ValidationBlock {
  const validation = block.actionType.actionTypeLogic.validation.parameterValidations[id];

  if (!validation) throw new Error(`The Action Type has no parameter ${id}.`);

  return validation;
}

function firstRule(block: ActionTypeBlock): IrRule {
  const rule = block.actionType.actionTypeLogic.logic.rules[0];

  if (!rule) throw new Error('The Action Type has no rule.');

  return rule;
}

function withCriterion(block: ActionTypeBlock, condition: unknown): ActionTypeBlock {
  block.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = {
    '0': {
      condition: unchecked<IrCondition>(condition),
      displayMetadata: { failureMessage: 'The status must be open.', typeClasses: [] },
    },
  };

  return block;
}

const CLIENT_INPUT = { name: 'client', dataType: { type: 'client', client: {} } };

const EDITS_OUTPUT = {
  single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
};

function discovered(
  functionName: string,
  inputs: { name: string; dataType: DiscoveredDataType; required?: boolean }[],
  editedObjects: string[],
  customTypes: Record<string, unknown> = {},
): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [CLIENT_INPUT, ...inputs],
    output: EDITS_OUTPUT,
    customTypes,
    ontologyProvenance: {
      editedObjects: Object.fromEntries(editedObjects.map((o) => [o, {}])),
      editedLinks: {},
      editedInterfaces: {},
    },
  };
}

const CLOSE_ACCOUNT = discovered(
  'closeAccount',
  [
    { name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } },
    { name: 'reason', dataType: { type: 'string', string: {} }, required: false },
  ],
  [ACCOUNT],
);

const SET_RELATIONSHIP = discovered(
  'setRelationship',
  [
    { name: 'probe', dataType: { type: 'object', object: { objectTypeId: STRUCT_PROBE } } },
    {
      name: 'relationship',
      dataType: {
        type: 'anonymousCustomType',
        anonymousCustomType: {
          fields: {
            label: { type: 'string', string: {} },
            since: { type: 'optionalType', optionalType: { wrappedType: { type: 'date', date: {} } } },
          },
        },
      },
    },
    { name: 'mode', dataType: { type: 'string', string: {} } },
  ],
  [STRUCT_PROBE],
);

const BUNDLE = 'export const functions = {}; export { createClient } from "@osdk/client";';

function functionsOf(...functions: DiscoveredFunction[]): PublishedFunctions {
  return { discovered: functions, bundle: BUNDLE };
}

function twin040(): ReturnType<typeof stored> {
  return stored(twinIr('0.4.0'), { functions: functionsOf(CLOSE_ACCOUNT) });
}

function functionBacked(
  functionName: string,
  functions?: PublishedFunctions,
  apiName = CLOSE_ACCOUNT_ACTION,
): StoredOntologyVersion {
  const block = renamed(twinActionType('0.4.0', 'close-account-action'), apiName);
  const rule = firstRule(block);

  if (rule.type !== 'functionRule') throw new Error('close-account-action has no Function rule.');

  rule.functionRule.functionRid = functionName;

  return stored(irWithActions('0.4.0', block), functions ? { functions } : {});
}

function editFunction(compiled: CompiledOntology, apiName: string): EditFunction {
  const fn = compiled.functions.get(apiName);

  if (fn?.kind !== 'edit') throw new Error(`Compile gave no edit Function ${apiName}.`);

  return fn;
}

function parts(actionType: CompiledActionType): Record<string, unknown> {
  return Object.fromEntries(
    [...actionType.parameters].map(([id, p]) => [id, { id: p.id, type: p.type, required: p.required }]),
  );
}

describe('Action Type API names', () => {
  it('service/http-api#errors: a camelCase name of 2 Action Types names no published name', () => {
    const names = publishedActionTypeNames([`${NS}step-2`, `${NS}step2`, `${NS}close-account-action`]);

    expect(Object.fromEntries(names)).toEqual({
      [`${NS}closeAccountAction`]: `${NS}close-account-action`,
      closeAccountAction: `${NS}close-account-action`,
    });
  });

  it('ontology/action-types/action-types#api-names: keys each Action Type by its fully qualified API name, with the API namespace', () => {
    const compiled = compileOrThrow(twin040());

    const names = [
      'create-account',
      'create-engagement',
      'set-engagement-status',
      'delete-account',
      'delete-engagement',
      'close-account-action',
    ].map((name) => `${NS}${name}`);

    expect([...compiled.actionTypes.keys()].sort()).toEqual([...names].sort());

    for (const name of names) expect(compiledActionType(compiled, name).apiName).toBe(name);
  });

  it('ontology/action-types/action-types#api-names: counts the full API name, and accepts 100 characters but refuses 101', () => {
    const name100 = `${NS}${'a'.repeat(100 - NS.length)}`;
    const name101 = `${name100}a`;

    expect(name100).toHaveLength(100);

    const withName = (apiName: string) =>
      stored(irWithActions('0.4.0', renamed(twinActionType('0.4.0', 'create-engagement'), apiName)));

    expect(compiledActionType(compileOrThrow(withName(name100)), name100).apiName).toBe(name100);

    expectRefused(withName(name101), name101, '1 to 100 characters');
  });

  it.each([`${NS}create-engagement`, `${NS}complete-task`, `${NS}v2`, `${NS}a-b-c2`])(
    'ontology/action-types/action-types#api-names: accepts %s, lowercase letters and digits in segments that hyphens separate',
    (apiName) => {
      const version = stored(irWithActions('0.4.0', renamed(twinActionType('0.4.0', 'create-engagement'), apiName)));

      expect(compiledActionType(compileOrThrow(version), apiName).apiName).toBe(apiName);
    },
  );

  it.each([
    `${NS}Create-Engagement`,
    `${NS}createEngagement`,
    `${NS}create_engagement`,
    `${NS}create engagement`,
    `${NS}create--engagement`,
    `${NS}create-engagement-`,
    `${NS}-create`,
  ])('ontology/action-types/action-types#api-names: refuses %s, and the error gives the rule', (apiName) => {
    const version = stored(irWithActions('0.4.0', renamed(twinActionType('0.4.0', 'create-engagement'), apiName)));

    expectRefused(version, apiName, 'lowercase letters and digits', 'hyphens');
  });

  it.each(['link', 'object', 'rid', 'ontology', 'relation', 'property'])(
    'ontology/object-link-types/object-types#api-names: refuses the reserved word %s as the part of an Action Type API name',
    (part) => {
      const apiName = `${NS}${part}`;
      const version = stored(irWithActions('0.4.0', renamed(twinActionType('0.4.0', 'create-engagement'), apiName)));

      expectRefused(version, apiName, 'reserved');
    },
  );

  it('ontology/action-types/action-types#api-names, ontology/object-link-types/object-types#api-names: refuses a dot in the part, next to the Object Type Account', () => {
    const apiName = `${NS}complete.task`;
    const version = stored(irWithActions('0.4.0', renamed(twinActionType('0.4.0', 'create-engagement'), apiName)));

    expectRefused(version, apiName, NS, /same API namespace/);
  });

  it('ontology/action-types/action-types#api-names: refuses 2 Object Types with different API namespaces', () => {
    const ir = irWithActions('0.4.0');
    const { [ACCOUNT]: account, [ENGAGEMENT]: engagement } = ir.ontology.objectTypes;

    if (!account || !engagement) throw new Error('The twin 0.4.0 IR has no Account or Engagement.');

    engagement.objectType.apiName = 'ai.other.Engagement';

    ir.ontology.objectTypes = { [ACCOUNT]: account, 'ai.other.Engagement': engagement };
    ir.ontology.linkTypes = {};

    expectRefused(stored(ir), 'ai.other.Engagement', NS, /same API namespace/);
  });

  function onlyActions(...apiNames: string[]): StoredOntologyVersion {
    const ir = irWithActions(
      '0.4.0',
      ...apiNames.map((apiName) => renamed(twinActionType('0.4.0', 'close-account-action'), apiName)),
    );

    ir.ontology.objectTypes = {};
    ir.ontology.linkTypes = {};

    const fn = discovered('closeAccount', [{ name: 'reason', dataType: { type: 'string', string: {} } }], []);

    return stored(ir, { functions: functionsOf(fn) });
  }

  it('ontology/action-types/action-types#api-names: with no Object Type, takes the API namespace of the first Action Type', () => {
    const compiled = compileOrThrow(onlyActions('ai.other.close-account', 'ai.other.close-account-2'));

    expect([...compiled.actionTypes.keys()].sort()).toEqual(['ai.other.close-account', 'ai.other.close-account-2']);

    expectRefused(
      onlyActions('ai.other.close-account', `${NS}close-account-action`),
      `${NS}close-account-action`,
      'ai.other.',
      /same API namespace/,
    );
  });

  it('ontology/action-types/action-types#api-names: refuses 2 Action Types with the same API name', () => {
    const ir = irWithActions('0.4.0', twinActionType('0.4.0', 'create-engagement'));

    ir.ontology.actionTypes[`${NS}create-engagement-2`] = twinActionType('0.4.0', 'create-engagement');

    expectRefused(stored(ir), CREATE_ENGAGEMENT, 'unique');
  });
});

describe('Action Type parameters', () => {
  const v1Types: [string, unknown, unknown, unknown][] = [
    ['string', { type: 'string', string: {} }, { type: 'text', text: { type: 'text', text: {} } }, { kind: 'string' }],
    [
      'boolean',
      { type: 'boolean', boolean: {} },
      { type: 'boolean', boolean: { type: 'boolean', boolean: {} } },
      { kind: 'boolean' },
    ],
    [
      'integer',
      { type: 'integer', integer: {} },
      { type: 'range', range: { type: 'range', range: {} } },
      { kind: 'integer' },
    ],
    [
      'double',
      { type: 'double', double: {} },
      { type: 'range', range: { type: 'range', range: {} } },
      { kind: 'double' },
    ],
    [
      'date',
      { type: 'date', date: {} },
      { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
      { kind: 'date' },
    ],
    [
      'timestamp',
      { type: 'timestamp', timestamp: {} },
      { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
      { kind: 'timestamp' },
    ],
    [
      'a list of String',
      { type: 'stringList', stringList: {} },
      { type: 'text', text: { type: 'text', text: {} } },
      { kind: 'list', element: { kind: 'string' } },
    ],
    [
      'a list of Integer',
      { type: 'integerList', integerList: {} },
      { type: 'range', range: { type: 'range', range: {} } },
      { kind: 'list', element: { kind: 'integer' } },
    ],
    [
      'a list of Boolean',
      { type: 'booleanList', booleanList: {} },
      { type: 'boolean', boolean: { type: 'boolean', boolean: {} } },
      { kind: 'list', element: { kind: 'boolean' } },
    ],
    [
      'a list of Double',
      { type: 'doubleList', doubleList: {} },
      { type: 'range', range: { type: 'range', range: {} } },
      { kind: 'list', element: { kind: 'double' } },
    ],
    [
      'a list of Date',
      { type: 'dateList', dateList: {} },
      { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
      { kind: 'list', element: { kind: 'date' } },
    ],
    [
      'a list of Timestamp',
      { type: 'timestampList', timestampList: {} },
      { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
      { kind: 'list', element: { kind: 'timestamp' } },
    ],
    [
      'an Object reference',
      { type: 'objectReference', objectReference: { objectTypeId: ACCOUNT } },
      { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
      { kind: 'object', objectType: ACCOUNT },
    ],
    [
      'a list of Object references',
      { type: 'objectReferenceList', objectReferenceList: { objectTypeId: ACCOUNT } },
      { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
      { kind: 'objectList', objectType: ACCOUNT },
    ],
  ];

  it.each(v1Types)(
    'ontology/action-types/action-types#parameters: accepts a parameter of type %s',
    (_name, type, allowed, expected) => {
      const block = withParameter(twinActionType('0.4.0', 'create-engagement'), 'extra', type, allowed);

      const parameter = compiledActionType(
        compileOrThrow(stored(irWithActions('0.4.0', block))),
        CREATE_ENGAGEMENT,
      ).parameters.get('extra');

      expect(parameter?.type).toEqual(expected);
    },
  );

  const decimals: [string, unknown, unknown][] = [
    ['Decimal with no precision', { type: 'decimal', decimal: {} }, { kind: 'decimal' }],
    [
      'Decimal with precision 10 and scale 2',
      { type: 'decimal', decimal: { precision: 10, scale: 2 } },
      { kind: 'decimal', precision: 10, scale: 2 },
    ],
    [
      'list of Decimal with no precision',
      { type: 'decimalList', decimalList: {} },
      { kind: 'list', element: { kind: 'decimal' } },
    ],
    [
      'list of Decimal with precision 10 and scale 2',
      { type: 'decimalList', decimalList: { precision: 10, scale: 2 } },
      { kind: 'list', element: { kind: 'decimal', precision: 10, scale: 2 } },
    ],
  ];

  it.each(decimals)(
    'ontology/action-types/action-types#parameters: accepts a parameter of type %s',
    (_name, type, expected) => {
      const block = withParameter(twinActionType('0.4.0', 'create-engagement'), 'extra', type, {
        type: 'range',
        range: { type: 'range', range: {} },
      });

      const parameter = compiledActionType(
        compileOrThrow(stored(irWithActions('0.4.0', block))),
        CREATE_ENGAGEMENT,
      ).parameters.get('extra');

      expect(parameter?.type).toStrictEqual(expected);
    },
  );

  it('gives a rule-backed parameter required: true only when the IR marks it required', () => {
    const compiled = compileOrThrow(
      stored(
        irWithActions(
          '0.4.0',
          twinActionType('0.4.0', 'create-engagement'),
          twinActionType('0.4.0', 'set-engagement-status'),
        ),
      ),
    );

    const engagement = compiledActionType(compiled, CREATE_ENGAGEMENT).parameters;
    const status = compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters;

    expect(engagement.get('title')?.required).toBe(true);
    expect(status.get('objectToModifyParameter')?.required).toBe(true);
    expect(engagement.get('amount')?.required).toBe(false);
    expect(status.get('status')?.required).toBe(false);
  });

  it('ontology/action-types/action-types#parameters: accepts a struct parameter', () => {
    const compiled = compileOrThrow(stored(irWithActions('0.6.3', twinActionType('0.6.3', 'create-struct-probe'))));

    expect(compiledActionType(compiled, CREATE_STRUCT_PROBE).parameters.get('relationship')?.type.kind).toBe('struct');
  });

  it.each([
    ['geohash', { type: 'geohash', geohash: {} }],
    ['geoshape', { type: 'geoshape', geoshape: {} }],
    ['marking', { type: 'marking', marking: {} }],
    ['timeSeriesReference', { type: 'timeSeriesReference', timeSeriesReference: {} }],
    ['geohashList', { type: 'geohashList', geohashList: {} }],
    ['geoshapeList', { type: 'geoshapeList', geoshapeList: {} }],
    ['markingList', { type: 'markingList', markingList: {} }],
  ])('ontology/action-types/action-types#parameters: refuses a parameter of type %s', (name, type) => {
    const block = withParameter(twinActionType('0.4.0', 'create-engagement'), 'extra', type, {
      type: 'oneOf',
      oneOf: { type: 'empty', empty: {} },
    });

    expectRefused(stored(irWithActions('0.4.0', block)), 'extra', name);
  });

  it('ontology/action-types/action-types#parameters: gives a struct parameter the fields and base types of its struct Property', () => {
    const compiled = compileOrThrow(stored(irWithActions('0.6.3', twinActionType('0.6.3', 'create-struct-probe'))));
    const relationship = compiledActionType(compiled, CREATE_STRUCT_PROBE).parameters.get('relationship');

    expect(relationship).toMatchObject({
      id: 'relationship',
      required: false,
      allowed: { kind: 'struct' },
      type: {
        kind: 'struct',
        fields: new Map([
          ['label', { type: { kind: 'string' }, required: false }],
          ['since', { type: { kind: 'date' }, required: false }],
        ]),
      },
    });
  });

  const fieldChanges: [string, Record<string, unknown>, string][] = [
    [
      'a field with another base type',
      { label: { type: 'string', string: {} }, since: { type: 'timestamp', timestamp: {} } },
      'since',
    ],
    ['a missing field', { label: { type: 'string', string: {} } }, 'since'],
    [
      'an extra field',
      {
        label: { type: 'string', string: {} },
        since: { type: 'date', date: {} },
        note: { type: 'string', string: {} },
      },
      'note',
    ],
  ];

  it.each(fieldChanges)(
    'ontology/action-types/action-types#parameters: refuses a struct parameter with %s, unlike the struct Property',
    (_change, structFieldTypes, field) => {
      const block = twinActionType('0.6.3', 'create-struct-probe');
      const parameter = block.actionType.metadata.parameters['relationship'];

      if (!parameter) throw new Error('create-struct-probe has no relationship parameter.');

      parameter.type = unchecked<IrParameterType>({ type: 'struct', struct: { structFieldTypes } });

      const rule = firstRule(block);

      if (rule.type !== 'addObjectRule') throw new Error('create-struct-probe has no Create object rule.');

      const mapped = rule.addObjectRule.structFieldValues['relationship'] ?? {};

      rule.addObjectRule.structFieldValues['relationship'] = Object.fromEntries(
        Object.entries(mapped).filter(([f]) => f in structFieldTypes),
      );

      expectRefused(stored(irWithActions('0.6.3', block)), /parameter/i, 'relationship', field);
    },
  );

  it('ontology/action-types/action-types#parameters: ignores render hints, visibility, sections, and order', () => {
    const plain = compiledActionType(
      compileOrThrow(stored(irWithActions('0.4.0', twinActionType('0.4.0', 'create-engagement')))),
      CREATE_ENGAGEMENT,
    );

    const block = twinActionType('0.4.0', 'create-engagement');
    const { metadata, actionTypeLogic } = block.actionType;
    const title = validationOf(block, 'title');

    title.defaultValidation.display = unchecked({
      renderHint: { type: 'dropdown', dropdown: {} },
      visibility: { type: 'hidden', hidden: {} },
    });

    metadata.parameterOrdering.reverse();

    metadata.formContentOrdering = unchecked([{ type: 'parameterId', parameterId: 'title' }]);

    metadata.sections = unchecked({
      details: {
        id: 'details',
        content: [{ type: 'parameterId', parameterId: 'title' }],
        displayMetadata: { displayName: 'Details' },
      },
    });

    actionTypeLogic.validation.sectionValidations = unchecked({
      details: { defaultDisplayMetadata: { visibility: { type: 'visible', visible: {} } }, conditionalOverrides: [] },
    });

    const changed = compiledActionType(compileOrThrow(stored(irWithActions('0.4.0', block))), CREATE_ENGAGEMENT);

    expect(changed).toEqual(plain);
  });
});

describe('IR shapes that the compiled Ontology cannot hold', () => {
  it('service/code-layout#seams: refuses a date bound that is not a fixed value', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'due',
      { type: 'date', date: {} },
      {
        type: 'datetime',
        datetime: { type: 'datetime', datetime: { minimum: { inclusive: true, value: { type: 'now', now: {} } } } },
      },
    );

    expectRefused(stored(irWithActions('0.4.0', block)), 'due', 'now');
  });

  it('service/code-layout#seams: refuses a range bound that is not a static value', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'count',
      { type: 'integer', integer: {} },
      {
        type: 'range',
        range: {
          type: 'range',
          range: { maximum: { inclusive: true, value: { type: 'parameterId', parameterId: 'amount' } } },
        },
      },
    );

    expectRefused(stored(irWithActions('0.4.0', block)), 'count', 'static value');
  });
});

describe('Object Types that turn off edits', () => {
  function withEdits(name: string, enabled: boolean): StoredOntologyVersion {
    const version = twin040();
    const block = version.ir.ontology.objectTypes[name];

    if (!block) throw new Error(`The twin 0.4.0 IR has no ${name}.`);

    unchecked<{ entityMetadata: Record<string, unknown> }>(block).entityMetadata['arePatchesEnabled'] = enabled;

    return version;
  }

  it('ontology/object-link-types/object-types#parts: accepts each rule on Object Types that turn on edits', () => {
    expect(compiledActionType(compileOrThrow(withEdits(ENGAGEMENT, true)), CREATE_ENGAGEMENT).apiName).toBe(
      CREATE_ENGAGEMENT,
    );
  });

  it('ontology/object-link-types/object-types#parts: refuses a Create object rule on an Object Type with arePatchesEnabled false, and the error gives the fix', () => {
    expectRefused(withEdits(ENGAGEMENT, false), ENGAGEMENT, 'turns off edits', 'editsEnabled: true');
  });

  it('ontology/object-link-types/object-types#parts: refuses a Function whose Edits type edits an Object Type with arePatchesEnabled false', () => {
    expectRefused(withEdits(ACCOUNT, false), 'closeAccount', ACCOUNT, 'turns off edits');
  });
});

describe('List lengths', () => {
  function withLength(type: unknown, length: Record<string, unknown>): StoredOntologyVersion {
    const block = withParameter(twinActionType('0.4.0', 'create-engagement'), 'ids', type, {
      type: 'text',
      text: { type: 'text', text: {} },
    });

    const validation = unchecked<{ defaultValidation: { validation: { required: unknown } } }>(
      validationOf(block, 'ids'),
    );

    validation.defaultValidation.validation.required = { type: 'listLengthValidation', listLengthValidation: length };

    return stored(irWithActions('0.4.0', block));
  }

  const strings = { type: 'stringList', stringList: {} };

  it('service/code-layout#seams: reads the list length of a list parameter', () => {
    const parameter = compiledActionType(
      compileOrThrow(withLength(strings, { minLength: 1, maxLength: 3 })),
      CREATE_ENGAGEMENT,
    ).parameters.get('ids');

    expect(parameter).toMatchObject({ required: true, listLength: { min: 1, max: 3 } });
  });

  it.each([
    ['a minimum that is a string', { minLength: '1' }, 'minLength'],
    ['a negative minimum', { minLength: -1 }, 'minLength'],
    ['a fractional maximum', { maxLength: 1.5 }, 'maxLength'],
  ])('service/code-layout#seams: refuses %s', (_name, length, field) => {
    expectRefused(withLength(strings, length), field);
  });

  it('service/code-layout#seams: reads a list length of 0', () => {
    const parameter = compiledActionType(
      compileOrThrow(withLength(strings, { minLength: 0, maxLength: 0 })),
      CREATE_ENGAGEMENT,
    ).parameters.get('ids');

    expect(parameter).toMatchObject({ listLength: { min: 0, max: 0 } });
  });

  it('service/code-layout#seams: refuses a list length whose minimum is more than its maximum', () => {
    expectRefused(withLength(strings, { minLength: 5, maxLength: 2 }), 'ids', 'more than its maximum');
  });

  it('service/code-layout#seams: refuses a list length on a parameter that is not a list', () => {
    expectRefused(withLength({ type: 'string', string: {} }, { minLength: 1 }), 'ids', 'not a list');
  });

  it('service/code-layout#seams: refuses a parameterLength condition value on a parameter that is not a list', () => {
    const block = withCriterion(twinActionType('0.4.0', 'create-engagement'), {
      type: 'comparison',
      comparison: {
        operator: 'GREATER_THAN',
        left: { type: 'parameterLength', parameterLength: { type: 'parameterId', parameterId: 'title' } },
        right: { type: 'staticValue', staticValue: { type: 'integer', integer: 0 } },
      },
    });

    expectRefused(stored(irWithActions('0.4.0', block)), 'title', 'not a list parameter');
  });
});

describe('Static values', () => {
  const date = { type: 'date', date: { dateValue: '2026-01-01' } };
  const decimal = { type: 'decimal', decimal: { decimalValue: '0.50' } };

  const allowedOf = (block: ActionTypeBlock, id: string) =>
    compiledActionType(compileOrThrow(stored(irWithActions('0.4.0', block))), CREATE_ENGAGEMENT).parameters.get(id)
      ?.allowed;

  it('service/code-layout#seams: reads a Date oneOf value, which the IR wraps as dateValue', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'due',
      { type: 'date', date: {} },
      {
        type: 'oneOf',
        oneOf: {
          type: 'oneOf',
          oneOf: { labelledValues: [{ label: 'New year', value: date }], otherValueAllowed: { allowed: false } },
        },
      },
    );

    expect(allowedOf(block, 'due')).toEqual({ kind: 'oneOf', values: ['2026-01-01'], otherValueAllowed: false });
  });

  it('service/code-layout#seams: reads a fixed Date bound, which the IR wraps as dateValue', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'due',
      { type: 'date', date: {} },
      {
        type: 'datetime',
        datetime: {
          type: 'datetime',
          datetime: {
            minimum: { inclusive: true, value: { type: 'fixed', fixed: { type: 'staticValue', staticValue: date } } },
          },
        },
      },
    );

    expect(allowedOf(block, 'due')).toEqual({ kind: 'datetime', min: { value: '2026-01-01', inclusive: true } });
  });

  it('service/code-layout#seams: reads a Decimal range bound, which the IR wraps as decimalValue', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'rate',
      { type: 'decimal', decimal: {} },
      {
        type: 'range',
        range: {
          type: 'range',
          range: { minimum: { inclusive: false, value: { type: 'staticValue', staticValue: decimal } } },
        },
      },
    );

    expect(allowedOf(block, 'rate')).toEqual({ kind: 'range', min: { value: '0.5', inclusive: false } });
  });

  const staticBound = (value: unknown) => ({ inclusive: true, value: { type: 'staticValue', staticValue: value } });

  const labelled = (...values: unknown[]) => ({
    labelledValues: values.map((value, i) => ({ label: `Option ${i + 1}`, value })),
    otherValueAllowed: { allowed: false },
  });

  it('ontology/action-types/action-types#parameters: keeps each Decimal range bound and oneOf option in its plain form, whatever its IR tag', () => {
    const range = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'rate',
      { type: 'decimal', decimal: {} },
      {
        type: 'range',
        range: {
          type: 'range',
          range: {
            minimum: staticBound({ type: 'decimal', decimal: { decimalValue: '+0.50' } }),
            maximum: staticBound({ type: 'integer', integer: 10 }),
          },
        },
      },
    );

    expect(allowedOf(range, 'rate')).toEqual({
      kind: 'range',
      min: { value: '0.5', inclusive: true },
      max: { value: '10', inclusive: true },
    });

    const oneOf = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'rate',
      { type: 'decimal', decimal: {} },
      {
        type: 'oneOf',
        oneOf: {
          type: 'oneOf',
          oneOf: labelled({ type: 'decimal', decimal: { decimalValue: '1.50' } }, { type: 'double', double: 2.25 }),
        },
      },
    );

    expect(allowedOf(oneOf, 'rate')).toEqual({ kind: 'oneOf', values: ['1.5', '2.25'], otherValueAllowed: false });
  });

  it.each([
    [
      'a range bound with Decimal text that is not a Decimal',
      'range',
      { type: 'decimal', decimal: { decimalValue: '1,5' } },
      '"1,5"',
    ],
    ['a range bound of the Double NaN', 'range', { type: 'double', double: 'NaN' }, '"NaN"'],
    [
      'a range bound whose plain form has more than 1,000 characters',
      'range',
      { type: 'decimal', decimal: { decimalValue: '1e1000' } },
      '"1e1000"',
    ],
    ['a oneOf option of a String', 'oneOf', { type: 'string', string: 'cheap' }, '"cheap"'],
    [
      'a oneOf option of a Decimal list',
      'oneOf',
      { type: 'decimalList', decimalList: { decimals: ['1.5'] } },
      '["1.5"]',
    ],
  ])(
    'ontology/action-types/action-types#parameters: refuses %s for a Decimal parameter, and names the value',
    (_case, kind, value, named) => {
      const allowedValues =
        kind === 'range'
          ? { type: 'range', range: { type: 'range', range: { maximum: staticBound(value) } } }
          : { type: 'oneOf', oneOf: { type: 'oneOf', oneOf: labelled(value) } };

      const block = withParameter(
        twinActionType('0.4.0', 'create-engagement'),
        'rate',
        { type: 'decimal', decimal: {} },
        allowedValues,
      );

      expectRefused(stored(irWithActions('0.4.0', block)), 'Parameter rate', named, 'is not a Decimal');
    },
  );

  it('service/code-layout#seams: names the list element that does not fit its type', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'note',
      { type: 'string', string: {} },
      {
        type: 'oneOf',
        oneOf: {
          type: 'oneOf',
          oneOf: {
            labelledValues: [{ label: 'Bad', value: { type: 'stringList', stringList: { strings: ['a', 1] } } }],
          },
        },
      },
    );

    expectRefused(
      stored(irWithActions('0.4.0', block)),
      'labelledValues.0.value.stringList.strings.1 is not a string value.',
    );
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'service/code-layout#seams: reads the Double bound %s, which JSON cannot hold as a number',
    (value) => {
      const block = withParameter(
        twinActionType('0.4.0', 'create-engagement'),
        'score',
        { type: 'double', double: {} },
        {
          type: 'range',
          range: {
            type: 'range',
            range: {
              maximum: {
                inclusive: true,
                value: { type: 'staticValue', staticValue: { type: 'double', double: value } },
              },
            },
          },
        },
      );

      expect(allowedOf(block, 'score')).toEqual({ kind: 'range', max: { value, inclusive: true } });
    },
  );

  it.each([
    ['string', { type: 'string', string: 5 }],
    ['integer', { type: 'integer', integer: 1.5 }],
    ['double', { type: 'double', double: 'abc' }],
    ['timestamp', { type: 'timestamp', timestamp: 12 }],
    ['date', { type: 'date', date: '2026-01-01' }],
    ['decimal', { type: 'decimal', decimal: 12.5 }],
    ['stringList', { type: 'stringList', stringList: { strings: ['a', 1] } }],
  ])('service/code-layout#seams: refuses a %s static value whose value does not fit its type', (_kind, value) => {
    const block = withParameter(
      twinActionType('0.4.0', 'create-engagement'),
      'note',
      { type: 'string', string: {} },
      {
        type: 'oneOf',
        oneOf: {
          type: 'oneOf',
          oneOf: { labelledValues: [{ label: 'Bad', value }], otherValueAllowed: { allowed: true } },
        },
      },
    );

    expectRefused(stored(irWithActions('0.4.0', block)), /is not (an object|a \w+ value)/);
  });
});

describe('Action Type features outside V1', () => {
  it('ontology/action-types/action-types#out-of-scope: refuses a conditional override, and the error names it', () => {
    const block = twinActionType('0.4.0', 'create-engagement');

    validationOf(block, 'title').conditionalOverrides = unchecked([
      {
        condition: { type: 'true', true: {} },
        parameterBlockOverrides: [{ type: 'visibility', visibility: { type: 'hidden', hidden: {} } }],
      },
    ]);

    expectRefused(stored(irWithActions('0.4.0', block)), 'title', /conditional ?override/i);
  });

  it('ontology/action-types/action-types#out-of-scope: accepts an empty list of conditional overrides', () => {
    const block = twinActionType('0.4.0', 'create-engagement');

    expect(validationOf(block, 'title').conditionalOverrides).toEqual([]);

    expect(
      compiledActionType(compileOrThrow(stored(irWithActions('0.4.0', block))), CREATE_ENGAGEMENT).parameters.has(
        'title',
      ),
    ).toBe(true);
  });

  it('ontology/action-types/action-types#out-of-scope: refuses a parameter filter on an Object reference, and the error names it', () => {
    const block = twinActionType('0.4.0', 'set-engagement-status');

    validationOf(block, 'objectToModifyParameter').defaultValidation.validation.allowedValues = unchecked({
      type: 'objectQuery',
      objectQuery: {
        type: 'objectQuery',
        objectQuery: { objectSet: { type: 'base', base: { objectTypeId: ENGAGEMENT } } },
      },
    });

    expectRefused(stored(irWithActions('0.4.0', block)), 'objectToModifyParameter', /parameter ?filter/i);
  });

  it('ontology/action-types/action-types#out-of-scope: accepts an Object reference with no filter', () => {
    const compiled = compileOrThrow(stored(irWithActions('0.4.0', twinActionType('0.4.0', 'set-engagement-status'))));

    expect(compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters.get('objectToModifyParameter')?.type).toEqual(
      {
        kind: 'object',
        objectType: ENGAGEMENT,
      },
    );
  });

  it('ontology/action-types/action-types#out-of-scope: refuses struct field validations on a rule-backed Action, and the error names them', () => {
    const block = twinActionType('0.6.3', 'create-struct-probe');

    validationOf(block, 'relationship').structFieldValidations = unchecked({
      label: {
        defaultValidation: {
          display: { visibility: { type: 'editable', editable: {} } },
          validation: {
            allowedValues: { type: 'text', text: { type: 'text', text: {} } },
            required: { type: 'required', required: {} },
          },
        },
        conditionalOverrides: [],
      },
    });

    expectRefused(stored(irWithActions('0.6.3', block)), 'relationship', /struct ?field ?validation/i);
  });

  it('ontology/action-types/action-types#out-of-scope: accepts a struct parameter with no struct field validations', () => {
    const block = twinActionType('0.6.3', 'create-struct-probe');

    expect(validationOf(block, 'relationship').structFieldValidations).toBeUndefined();

    expect(
      compiledActionType(compileOrThrow(stored(irWithActions('0.6.3', block))), CREATE_STRUCT_PROBE).parameters.has(
        'relationship',
      ),
    ).toBe(true);
  });

  const outsideTypes: [string, unknown, RegExp][] = [
    ['Long', { type: 'long', long: {} }, /long/i],
    [
      'struct list',
      { type: 'structList', structList: { structFieldTypes: { label: { type: 'string', string: {} } } } },
      /struct ?list/i,
    ],
    ['Attachment', { type: 'attachment', attachment: {} }, /attachment/i],
    ['Media reference', { type: 'mediaReference', mediaReference: {} }, /media ?reference/i],
    ['Object Set', { type: 'objectSetRid', objectSetRid: { objectTypeId: ACCOUNT } }, /object ?set/i],
    [
      'Interface reference',
      { type: 'interfaceReference', interfaceReference: { interfaceTypeRid: `${NS}Party` } },
      /interface ?reference/i,
    ],
    ['Object Type reference', { type: 'objectTypeReference', objectTypeReference: {} }, /object ?type ?reference/i],
    ['list of Long', { type: 'longList', longList: {} }, /long/i],
    ['list of Attachment', { type: 'attachmentList', attachmentList: {} }, /attachment/i],
    ['list of Media reference', { type: 'mediaReferenceList', mediaReferenceList: {} }, /media ?reference/i],
    [
      'list of Interface reference',
      { type: 'interfaceReferenceList', interfaceReferenceList: { interfaceTypeRid: `${NS}Party` } },
      /interface ?reference/i,
    ],
  ];

  it.each(outsideTypes)(
    'ontology/action-types/action-types#out-of-scope: refuses the parameter type %s, and the error names it',
    (_name, type, words) => {
      const block = withParameter(twinActionType('0.4.0', 'create-engagement'), 'extra', type, {
        type: 'oneOf',
        oneOf: { type: 'empty', empty: {} },
      });

      expectRefused(stored(irWithActions('0.4.0', block)), 'extra', words);
    },
  );

  const outsideAllowedValues: [string, unknown, RegExp][] = [
    ['groups', { type: 'multipassGroup', multipassGroup: { type: 'group', group: { filter: [] } } }, /group/i],
    ['CBAC markings', { type: 'cbacMarking', cbacMarking: { type: 'cbacMarking', cbacMarking: {} } }, /marking/i],
    [
      'mandatory markings',
      { type: 'mandatoryMarking', mandatoryMarking: { type: 'mandatoryMarking', mandatoryMarking: {} } },
      /marking/i,
    ],
    [
      'organization markings',
      { type: 'organizationMarking', organizationMarking: { type: 'organizationMarking', organizationMarking: {} } },
      /marking/i,
    ],
    [
      'value types',
      { type: 'valueType', valueType: { type: 'valueType', valueType: { valueTypeRid: 'phone' } } },
      /value ?type/i,
    ],
  ];

  it.each(outsideAllowedValues)(
    'ontology/action-types/action-types#out-of-scope: refuses allowed values for %s, and the error names them',
    (_name, allowedValues, words) => {
      const block = twinActionType('0.4.0', 'set-engagement-status');

      validationOf(block, 'status').defaultValidation.validation.allowedValues = unchecked(allowedValues);

      expectRefused(stored(irWithActions('0.4.0', block)), 'status', words);
    },
  );

  const userAllowed = (filter: unknown[] = []) => ({ type: 'user', user: { type: 'user', user: { filter } } });

  it('ontology/action-types/action-types#parameters: compiles the user allowed values of a String parameter', () => {
    const block = twinActionType('0.4.0', 'set-engagement-status');

    validationOf(block, 'status').defaultValidation.validation.allowedValues = unchecked(userAllowed());

    const compiled = compileOrThrow(stored(irWithActions('0.4.0', block)));

    expect(compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters.get('status')?.allowed).toEqual({
      kind: 'user',
    });
  });

  it('ontology/action-types/action-types#parameters: compiles the user allowed values of a list of String', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'set-engagement-status'),
      'owners',
      { type: 'stringList', stringList: {} },
      userAllowed(),
    );

    const compiled = compileOrThrow(stored(irWithActions('0.4.0', block)));

    expect(compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters.get('owners')).toMatchObject({
      type: { kind: 'list', element: { kind: 'string' } },
      allowed: { kind: 'user' },
    });
  });

  it('ontology/action-types/action-types#parameters: refuses the user allowed values with fromGroups, and the error names them', () => {
    const block = twinActionType('0.4.0', 'set-engagement-status');

    const group = {
      type: 'groupFilter',
      groupFilter: { groupId: { type: 'staticValue', staticValue: { type: 'string', string: 'crew' } } },
    };

    validationOf(block, 'status').defaultValidation.validation.allowedValues = unchecked(userAllowed([group]));

    expectRefused(stored(irWithActions('0.4.0', block)), 'status', /fromGroups/);
  });

  it('ontology/action-types/action-types#parameters: refuses the user allowed values on a parameter that is not a String', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'set-engagement-status'),
      'count',
      { type: 'integer', integer: {} },
      userAllowed(),
    );

    expectRefused(stored(irWithActions('0.4.0', block)), 'count', /user.*integer/);
  });

  it('ontology/action-types/action-types#parameters: a String parameter with no user kind publishes with its own allowed values', () => {
    const block = withParameter(
      twinActionType('0.4.0', 'set-engagement-status'),
      'assignee',
      { type: 'string', string: {} },
      { type: 'text', text: { type: 'text', text: {} } },
    );

    const compiled = compileOrThrow(stored(irWithActions('0.4.0', block)));

    expect(compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters.get('assignee')?.allowed).toEqual({
      kind: 'text',
    });
  });
});

function manyToManyLinkType(id: string): LinkTypeBlock {
  const side = (apiName: string, displayName: string) => ({
    apiName,
    displayMetadata: { displayName, pluralDisplayName: displayName, visibility: 'NORMAL', groupDisplayName: '' },
    typeClasses: [],
  });

  return unchecked<LinkTypeBlock>({
    linkType: {
      definition: {
        type: 'manyToMany',
        manyToMany: {
          objectTypeAToBLinkMetadata: side('pairedEngagements', 'Paired Engagements'),
          objectTypeBToALinkMetadata: side('pairedAccounts', 'Paired Accounts'),
          objectTypeRidA: ACCOUNT,
          objectTypeRidB: ENGAGEMENT,
          objectTypeAPrimaryKeyPropertyMapping: [
            { from: { apiName: 'accountId', object: ACCOUNT }, to: { apiName: 'accountId', object: ACCOUNT } },
          ],
          objectTypeBPrimaryKeyPropertyMapping: [
            {
              from: { apiName: 'engagementId', object: ENGAGEMENT },
              to: { apiName: 'engagementId', object: ENGAGEMENT },
            },
          ],
        },
      },
      id,
      status: { type: 'active', active: {} },
      redacted: false,
    },
    datasources: [
      {
        datasourceName: id,
        datasource: {
          type: 'dataset',
          dataset: {
            datasetRid: `link-${id}`,
            objectTypeAPrimaryKeyMapping: [
              { property: { apiName: 'accountId', object: ACCOUNT }, column: 'accountId' },
            ],
            objectTypeBPrimaryKeyMapping: [
              { property: { apiName: 'engagementId', object: ENGAGEMENT }, column: 'engagementId' },
            ],
          },
        },
        editsConfiguration: { onlyAllowPrivilegedEdits: false },
        redacted: false,
      },
    ],
    entityMetadata: { arePatchesEnabled: true },
  });
}

function linkRuleVersion(kind: 'addLinkRule' | 'deleteLinkRule', linkTypeId: string): StoredOntologyVersion {
  const block = renamed(twinActionType('0.4.0', 'delete-account'), `${NS}pair-account`);
  const { metadata, actionTypeLogic } = block.actionType;

  metadata.parameters = {};
  metadata.parameterOrdering = [];

  actionTypeLogic.validation.parameterValidations = {};

  withParameter(
    block,
    'account',
    { type: 'objectReference', objectReference: { objectTypeId: ACCOUNT } },
    {
      type: 'objectQuery',
      objectQuery: { type: 'objectQuery', objectQuery: {} },
    },
  );

  withParameter(
    block,
    'engagement',
    { type: 'objectReference', objectReference: { objectTypeId: ENGAGEMENT } },
    {
      type: 'objectQuery',
      objectQuery: { type: 'objectQuery', objectQuery: {} },
    },
  );

  const body = { linkTypeId, sourceObject: 'account', targetObject: 'engagement' };

  actionTypeLogic.logic.rules = [unchecked<IrRule>({ type: kind, [kind]: body })];

  const ir = irWithActions('0.4.0', block);

  ir.ontology.linkTypes['account-engagement-pairs'] = manyToManyLinkType('account-engagement-pairs');

  return stored(ir);
}

describe('Rules', () => {
  it.each([
    ['addLinkRule', 'addLink'],
    ['deleteLinkRule', 'deleteLink'],
  ] as const)(
    'ontology/action-types/rules#rule-kinds: accepts a %s on a many-to-many Link Type',
    (kind, expectedKind) => {
      const actionType = compiledActionType(
        compileOrThrow(linkRuleVersion(kind, 'account-engagement-pairs')),
        `${NS}pair-account`,
      );

      expect(actionType.logic.kind).toBe('rules');

      if (actionType.logic.kind !== 'rules') return;

      expect(actionType.logic.rules).toEqual([
        {
          kind: expectedKind,
          link: 'pairedEngagements',
          source: 'account',
          target: 'engagement',
        },
      ]);
    },
  );

  it.each(['addLinkRule', 'deleteLinkRule'] as const)(
    'ontology/action-types/rules#rule-kinds: refuses a %s on a one-to-many Link Type',
    (kind) => {
      expectRefused(linkRuleVersion(kind, 'account-to-engagements'), 'account-to-engagements', /many-to-many/i);
    },
  );

  it('ontology/action-types/rules#rule-kinds: refuses an Action Type with a Function rule and another rule', () => {
    const block = twinActionType('0.4.0', 'close-account-action');

    block.actionType.actionTypeLogic.logic.rules.push(firstRule(twinActionType('0.4.0', 'create-account')));

    expectRefused(
      stored(irWithActions('0.4.0', block), { functions: functionsOf(CLOSE_ACCOUNT) }),
      CLOSE_ACCOUNT_ACTION,
      /function rule/i,
      /no other rule/i,
    );
  });

  it('ontology/action-types/rules#rule-kinds: accepts an Action Type with a Function rule and no other rule', () => {
    const compiled = compileOrThrow(functionBacked('closeAccount', functionsOf(CLOSE_ACCOUNT)));

    expect(compiledActionType(compiled, CLOSE_ACCOUNT_ACTION).logic).toEqual({
      kind: 'function',
      function: 'closeAccount',
    });
  });

  function withRule(rule: unknown): StoredOntologyVersion {
    const block = twinActionType('0.4.0', 'set-engagement-status');

    block.actionType.actionTypeLogic.logic.rules = [unchecked<IrRule>(rule)];

    return stored(irWithActions('0.4.0', block));
  }

  it('ontology/action-types/rules#out-of-scope: refuses a Create or modify object rule, and the error names it', () => {
    const rule = {
      type: 'addOrModifyObjectRuleV2',
      addOrModifyObjectRuleV2: {
        objectToModify: 'objectToModifyParameter',
        propertyValues: { status: { type: 'parameterId', parameterId: 'status' } },
        structFieldValues: {},
      },
    };

    expectRefused(withRule(rule), SET_ENGAGEMENT_STATUS, /create or modify object/i);
  });

  it('ontology/action-types/rules#out-of-scope: refuses an Object reference parameter with maybeCreateObjectOption, the upsert of Create or modify object', () => {
    const block = twinActionType('0.4.0', 'set-engagement-status');

    const reference = Object.values(block.actionType.metadata.parameters).find(
      (p) => p.type.type === 'objectReference',
    );

    if (!reference || reference.type.type !== 'objectReference')
      throw new Error('set-engagement-status has no Object reference parameter.');

    unchecked<Record<string, unknown>>(reference.type.objectReference)['maybeCreateObjectOption'] = {
      type: 'userInput',
      userInput: {},
    };

    expectRefused(stored(irWithActions('0.4.0', block)), SET_ENGAGEMENT_STATUS, /create or modify object/i);
  });

  const interfaceRules: [string, unknown][] = [
    ['addInterfaceRule', { interfaceApiName: `${NS}Party`, interfacePropertyValues: {}, redacted: false }],
    ['modifyInterfaceRule', { interfaceObjectToModify: 'objectToModifyParameter', interfacePropertyValues: {} }],
    [
      'addInterfaceLinkRuleV2',
      { interfaceLinkTypeRid: 'members', interfaceTypeRid: `${NS}Party`, sourceObjects: [], targetObjects: [] },
    ],
    [
      'deleteInterfaceLinkRule',
      { interfaceLinkTypeRid: 'members', interfaceTypeRid: `${NS}Party`, sourceObject: 'a', targetObject: 'b' },
    ],
  ];

  it.each(interfaceRules)(
    'ontology/action-types/rules#out-of-scope: refuses the Interface rule %s, and the error names it',
    (type, body) => {
      expectRefused(withRule({ type, [type]: body }), SET_ENGAGEMENT_STATUS, /interface/i, type);
    },
  );

  it('ontology/action-types/rules#out-of-scope: refuses a Scenario rule, and the error names it', () => {
    expectRefused(withRule({ type: 'scenarioRule', scenarioRule: {} }), SET_ENGAGEMENT_STATUS, /scenario/i);
  });

  const outsideValues: [string, unknown, RegExp][] = [
    [
      'interfaceParameterPropertyValue',
      { parameterId: 'objectToModifyParameter', sharedPropertyTypeRid: `${NS}partyName` },
      /interface ?parameter ?propert/i,
    ],
    [
      'mediaReferenceParameterPropertyValue',
      { parameterId: 'objectToModifyParameter', propertyTypeId: 'status' },
      /media ?reference/i,
    ],
    ['synchronousWebhookOutput', { webhookOutputParamName: 'status' }, /webhook ?output/i],
    ['scheduleRunRid', {}, /schedule ?run/i],
  ];

  it.each(outsideValues)(
    'ontology/action-types/rules#out-of-scope: refuses the rule value %s, and the error names it',
    (type, body, words) => {
      const rule = {
        type: 'modifyObjectRule',
        modifyObjectRule: {
          objectToModify: 'objectToModifyParameter',
          propertyValues: { status: { type, [type]: body } },
          structFieldValues: {},
        },
      };

      expectRefused(withRule(rule), SET_ENGAGEMENT_STATUS, words);
    },
  );

  function readsProperty(parameterId: string, property: string): unknown {
    const value = {
      type: 'objectParameterPropertyValue',
      objectParameterPropertyValue: { parameterId, propertyTypeId: property },
    };

    return {
      type: 'modifyObjectRule',
      modifyObjectRule: {
        objectToModify: 'objectToModifyParameter',
        propertyValues: { status: value },
        structFieldValues: {},
      },
    };
  }

  it('service/code-layout#seams: refuses a rule value that reads a Property that the Object Type of the parameter does not have', () => {
    expectRefused(
      withRule(readsProperty('objectToModifyParameter', 'nope')),
      SET_ENGAGEMENT_STATUS,
      'objectToModifyParameter',
      'nope',
    );
  });

  it('service/code-layout#seams: accepts a rule value that reads a Property of the Object Type of the parameter', () => {
    const actionType = compiledActionType(
      compileOrThrow(withRule(readsProperty('objectToModifyParameter', 'status'))),
      SET_ENGAGEMENT_STATUS,
    );

    expect(actionType.logic).toEqual({
      kind: 'rules',
      rules: [
        {
          kind: 'modifyObject',
          object: 'objectToModifyParameter',
          properties: new Map([
            ['status', { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'status' }],
          ]),
        },
      ],
    });
  });

  it('ontology/action-types/rules#out-of-scope: accepts the V1 rule values of the twin', () => {
    const compiled = compileOrThrow(stored(irWithActions('0.4.0', twinActionType('0.4.0', 'create-engagement'))));

    expect(compiledActionType(compiled, CREATE_ENGAGEMENT).logic).toEqual({
      kind: 'rules',
      rules: [
        {
          kind: 'addObject',
          objectType: ENGAGEMENT,
          properties: new Map<string, unknown>([
            ['engagementId', { kind: 'parameter', parameter: 'engagementId' }],
            ['accountId', { kind: 'parameter', parameter: 'accountId' }],
            ['title', { kind: 'parameter', parameter: 'title' }],
            ['amount', { kind: 'parameter', parameter: 'amount' }],
            ['status', { kind: 'static', value: 'open' }],
            ['createdAt', { kind: 'currentTime' }],
          ]),
        },
      ],
    });
  });
});

describe('Struct Property values', () => {
  function fieldOf(parameterId: string, field: string): unknown {
    return { type: 'structParameterFieldValue', structParameterFieldValue: { parameterId, structFieldApiName: field } };
  }

  function relationshipMapped(fields: Record<string, unknown>): StoredOntologyVersion {
    const block = twinActionType('0.6.3', 'create-struct-probe');
    const rule = firstRule(block);

    if (rule.type !== 'addObjectRule') throw new Error('create-struct-probe has no Create object rule.');

    rule.addObjectRule.structFieldValues['relationship'] = unchecked(fields);

    return stored(irWithActions('0.6.3', block));
  }

  it('service/code-layout#seams: accepts a struct Property that maps each field to the same field of 1 struct parameter', () => {
    const version = relationshipMapped({
      label: fieldOf('relationship', 'label'),
      since: fieldOf('relationship', 'since'),
    });

    const actionType = compiledActionType(compileOrThrow(version), CREATE_STRUCT_PROBE);

    if (actionType.logic.kind !== 'rules') throw new Error('create-struct-probe is not rule-backed.');

    const rule = actionType.logic.rules[0];

    if (rule?.kind !== 'addObject') throw new Error('create-struct-probe has no Create object rule.');

    expect(rule.properties.get('relationship')).toEqual({ kind: 'structParameter', parameter: 'relationship' });
  });

  it('service/code-layout#seams: refuses a struct Property that does not map 1 of its fields', () => {
    expectRefused(
      relationshipMapped({ label: fieldOf('relationship', 'label') }),
      CREATE_STRUCT_PROBE,
      'relationship',
      'since',
    );
  });

  it.each(['relationship', 'probeId', 'noSuchProperty'])(
    'service/code-layout#seams: refuses a structFieldValues entry with no field for %s',
    (name) => {
      const block = twinActionType('0.6.3', 'create-struct-probe');
      const rule = firstRule(block);

      if (rule.type !== 'addObjectRule') throw new Error('create-struct-probe has no Create object rule.');

      rule.addObjectRule.structFieldValues[name] = unchecked({});

      expectRefused(stored(irWithActions('0.6.3', block)), CREATE_STRUCT_PROBE, name);
    },
  );

  it('service/code-layout#seams: refuses a mapped field that the struct Property does not have', () => {
    const version = relationshipMapped({
      label: fieldOf('relationship', 'label'),
      since: fieldOf('relationship', 'since'),
      note: fieldOf('relationship', 'note'),
    });

    expectRefused(version, CREATE_STRUCT_PROBE, 'relationship', 'note');
  });

  it('service/code-layout#seams: refuses a field mapped to another field of the struct parameter', () => {
    const version = relationshipMapped({
      label: fieldOf('relationship', 'label'),
      since: fieldOf('relationship', 'label'),
    });

    expectRefused(version, CREATE_STRUCT_PROBE, 'relationship', 'since');
  });

  it('service/code-layout#seams: refuses a struct Property that maps its fields from 2 parameters', () => {
    const version = relationshipMapped({
      label: fieldOf('relationship', 'label'),
      since: fieldOf('measures', 'since'),
    });

    expectRefused(version, CREATE_STRUCT_PROBE, 'relationship', 'since', 'measures');
  });

  it('service/code-layout#seams: refuses a struct Property in propertyValues, outside structFieldValues', () => {
    const block = twinActionType('0.6.3', 'create-struct-probe');
    const rule = firstRule(block);

    if (rule.type !== 'addObjectRule') throw new Error('create-struct-probe has no Create object rule.');

    delete rule.addObjectRule.structFieldValues['relationship'];

    rule.addObjectRule.propertyValues['relationship'] = { type: 'parameterId', parameterId: 'relationship' };

    expectRefused(stored(irWithActions('0.6.3', block)), CREATE_STRUCT_PROBE, 'relationship', /structFieldValues/);
  });
});

describe('Submission criteria', () => {
  function withCondition(condition: unknown): StoredOntologyVersion {
    return stored(irWithActions('0.4.0', withCriterion(twinActionType('0.4.0', 'set-engagement-status'), condition)));
  }

  it.each([
    ['or', 1500],
    ['not', 3000],
  ] as const)(
    'ontology/action-types/submission-criteria: compiles a condition of %s nested %i times, as before the yielded failures',
    (kind, depth) => {
      let condition: unknown = STATUS_IS_OPEN;

      for (let level = 0; level < depth; level += 1)
        condition =
          kind === 'or' ? { type: 'or', or: { conditions: [condition] } } : { type: 'not', not: { condition } };

      expect(
        compiledActionType(compileOrThrow(withCondition(condition)), `${NS}set-engagement-status`).criteria,
      ).toHaveLength(1);
    },
  );

  const STATUS_IS_OPEN = {
    type: 'comparison',
    comparison: {
      operator: 'EQUALS',
      left: { type: 'parameterId', parameterId: 'status' },
      right: { type: 'staticValue', staticValue: { type: 'string', string: 'open' } },
    },
  };

  const IN_GROUP = {
    type: 'comparison',
    comparison: {
      operator: 'INTERSECTS',
      left: {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: {} },
          propertyValue: { type: 'groupIds', groupIds: {} },
        },
      },
      right: { type: 'staticValue', staticValue: { type: 'stringList', stringList: { strings: ['sales'] } } },
    },
  };

  const USER_IS = {
    type: 'comparison',
    comparison: {
      operator: 'EQUALS',
      left: {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: {} },
          propertyValue: { type: 'userId', userId: {} },
        },
      },
      right: { type: 'staticValue', staticValue: { type: 'string', string: 'u-1' } },
    },
  };

  function propertyIs(parameterId: string, property: string): unknown {
    return {
      type: 'comparison',
      comparison: {
        operator: 'EQUALS',
        left: {
          type: 'objectParameterPropertyValue',
          objectParameterPropertyValue: { parameterId, propertyTypeId: property },
        },
        right: { type: 'staticValue', staticValue: { type: 'string', string: 'open' } },
      },
    };
  }

  it('service/code-layout#seams: refuses a condition that reads a Property of a String parameter', () => {
    expectRefused(
      withCondition(propertyIs('status', 'status')),
      SET_ENGAGEMENT_STATUS,
      'status',
      /Object reference parameter/,
    );
  });

  it('service/code-layout#seams: refuses a condition that reads a Property that the Object Type of the parameter does not have', () => {
    expectRefused(
      withCondition(propertyIs('objectToModifyParameter', 'nope')),
      SET_ENGAGEMENT_STATUS,
      'objectToModifyParameter',
      'nope',
    );
  });

  it('service/code-layout#seams: accepts a condition that reads a Property of the Object Type of the parameter', () => {
    const actionType = compiledActionType(
      compileOrThrow(withCondition(propertyIs('objectToModifyParameter', 'status'))),
      SET_ENGAGEMENT_STATUS,
    );

    expect(actionType.criteria[0]?.condition).toEqual({
      kind: 'comparison',
      operator: 'EQUALS',
      left: { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'status' },
      right: { kind: 'static', value: 'open' },
    });
  });

  it('accepts a comparison of a parameter and a static value', () => {
    const actionType = compiledActionType(compileOrThrow(withCondition(STATUS_IS_OPEN)), SET_ENGAGEMENT_STATUS);

    expect(actionType.criteria.map((c) => c.condition.kind)).toEqual(['comparison']);
  });

  const USER_ATTRIBUTE_IS = {
    type: 'comparison',
    comparison: {
      operator: 'EQUALS',
      left: {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: {} },
          propertyValue: { type: 'userAttributes', userAttributes: { attributeKey: 'region' } },
        },
      },
      right: { type: 'staticValue', staticValue: { type: 'string', string: 'emea' } },
    },
  };

  const PERSON = 'ontology/action-types/submission-criteria#person-values';
  const PERMISSIONS = { kind: 'person', fact: { kind: 'permissions' } };

  const userValue = (propertyValue: unknown) => ({
    type: 'userProperty',
    userProperty: { userId: { type: 'currentUser', currentUser: {} }, propertyValue },
  });

  const personComparison = (operator: string, left: unknown, right: unknown) => ({
    type: 'comparison',
    comparison: { operator, left, right },
  });

  const PERMISSIONS_VALUE = userValue({ type: 'groupIds', groupIds: {} });
  const OPEN = { type: 'staticValue', staticValue: { type: 'string', string: 'open' } };

  const objectProperty = (propertyTypeId: string) => ({
    type: 'objectParameterPropertyValue',
    objectParameterPropertyValue: { parameterId: 'objectToModifyParameter', propertyTypeId },
  });

  const criterionOf = (condition: unknown) =>
    compiledActionType(compileOrThrow(withCondition(condition)), SET_ENGAGEMENT_STATUS).criteria[0]?.condition;

  it.each([
    [
      'the user groups (the maker group condition)',
      IN_GROUP,
      { kind: 'comparison', operator: 'INTERSECTS', left: PERMISSIONS, right: { kind: 'static', value: ['sales'] } },
    ],
    [
      'the user ID',
      USER_IS,
      {
        kind: 'comparison',
        operator: 'EQUALS',
        left: { kind: 'person', fact: { kind: 'userId' } },
        right: { kind: 'static', value: 'u-1' },
      },
    ],
    [
      'a user attribute',
      USER_ATTRIBUTE_IS,
      {
        kind: 'comparison',
        operator: 'EQUALS',
        left: { kind: 'person', fact: { kind: 'attribute', name: 'region' } },
        right: { kind: 'static', value: 'emea' },
      },
    ],
  ])(`compiles a condition on %s of the current user`, (_name, condition, expected) => {
    expect(criterionOf(condition)).toEqual(expected);
  });

  it(`compiles a current user condition inside an and, an or, and a not`, () => {
    expect(
      criterionOf({
        type: 'and',
        and: {
          conditions: [
            STATUS_IS_OPEN,
            { type: 'not', not: { condition: { type: 'or', or: { conditions: [IN_GROUP] } } } },
          ],
        },
      }),
    ).toEqual({
      kind: 'and',
      conditions: [
        {
          kind: 'comparison',
          operator: 'EQUALS',
          left: { kind: 'parameter', parameter: 'status' },
          right: { kind: 'static', value: 'open' },
        },
        {
          kind: 'not',
          condition: {
            kind: 'or',
            conditions: [
              {
                kind: 'comparison',
                operator: 'INTERSECTS',
                left: PERMISSIONS,
                right: { kind: 'static', value: ['sales'] },
              },
            ],
          },
        },
      ],
    });
  });

  it.each([
    ['a String parameter', { type: 'parameterId', parameterId: 'status' }, { kind: 'parameter', parameter: 'status' }],
    [
      'a String Property of an Object parameter',
      objectProperty('status'),
      { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'status' },
    ],
    ['a static String', OPEN, { kind: 'static', value: 'open' }],
  ])(`compiles user.permissions against %s, on each side`, (_name, other, compiledOther) => {
    expect(criterionOf(personComparison('INTERSECTS', PERMISSIONS_VALUE, other))).toEqual({
      kind: 'comparison',
      operator: 'INTERSECTS',
      left: PERMISSIONS,
      right: compiledOther,
    });

    expect(criterionOf(personComparison('INTERSECTS', other, PERMISSIONS_VALUE))).toEqual({
      kind: 'comparison',
      operator: 'INTERSECTS',
      left: compiledOther,
      right: PERMISSIONS,
    });
  });

  it.each([
    ['a static Integer', { type: 'staticValue', staticValue: { type: 'integer', integer: 1 } }, 'static'],
    ['a static null', { type: 'staticValue', staticValue: { type: 'null', null: {} } }, 'static'],
    ['a static Boolean', { type: 'staticValue', staticValue: { type: 'boolean', boolean: true } }, 'static'],
    ['a Property that is not a String', objectProperty('createdAt'), 'objectProperty'],
    ['an Object parameter', { type: 'parameterId', parameterId: 'objectToModifyParameter' }, 'parameter'],
    ['another person value', userValue({ type: 'userId', userId: {} }), '2 person values'],
  ])(`refuses user.permissions against %s, and the error names the other value`, (_name, other, named) => {
    expectFeatureRefused(
      withCondition(personComparison('INTERSECTS', PERMISSIONS_VALUE, other)),
      SET_ENGAGEMENT_STATUS,
      'person value',
      named,
    );

    expectFeatureRefused(
      withCondition(personComparison('INTERSECTS', other, PERMISSIONS_VALUE)),
      SET_ENGAGEMENT_STATUS,
      'person value',
      named,
    );
  });

  function withExtras(parameterType: unknown, propertyType: unknown, condition: unknown): StoredOntologyVersion {
    const block = withParameter(
      withCriterion(twinActionType('0.4.0', 'set-engagement-status'), condition),
      'extra',
      parameterType,
      { type: 'range', range: { type: 'range', range: {} } },
    );

    const ir = irWithActions('0.4.0', block);
    const engagement = ir.ontology.objectTypes[ENGAGEMENT];

    if (!engagement) throw new Error('The twin 0.4.0 IR has no Engagement.');

    engagement.objectType.propertyTypes['extra'] = propertyOfType('extra', unchecked(propertyType));

    return stored(ir);
  }

  const INTEGER_LIST = { type: 'integerList', integerList: {} };
  const INTEGER_ARRAY = { type: 'array', array: { subtype: { type: 'integer', integer: {} }, reducers: [] } };
  const STRING_ARRAY = { type: 'array', array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] } };

  it.each([
    [
      'a static Integer list',
      { type: 'staticValue', staticValue: { type: 'integerList', integerList: { integers: [1] } } },
      'static',
    ],
    ['a list parameter of Integers', { type: 'parameterId', parameterId: 'extra' }, 'parameter'],
    ['an Integer array Property', objectProperty('extra'), 'objectProperty'],
  ])(`refuses user.permissions against %s, and the error names the other value`, (_name, other, named) => {
    expectFeatureRefused(
      withExtras(INTEGER_LIST, INTEGER_ARRAY, personComparison('INTERSECTS', PERMISSIONS_VALUE, other)),
      SET_ENGAGEMENT_STATUS,
      'person value',
      named,
    );

    expectFeatureRefused(
      withExtras(INTEGER_LIST, INTEGER_ARRAY, personComparison('INTERSECTS', other, PERMISSIONS_VALUE)),
      SET_ENGAGEMENT_STATUS,
      'person value',
      named,
    );
  });

  it(`compiles user.permissions against a String array Property`, () => {
    const actionType = compiledActionType(
      compileOrThrow(
        withExtras(
          INTEGER_LIST,
          STRING_ARRAY,
          personComparison('INTERSECTS', PERMISSIONS_VALUE, objectProperty('extra')),
        ),
      ),
      SET_ENGAGEMENT_STATUS,
    );

    expect(actionType.criteria[0]?.condition).toEqual({
      kind: 'comparison',
      operator: 'INTERSECTS',
      left: PERMISSIONS,
      right: { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'extra' },
    });
  });

  it.each(['LESS_THAN', 'LESS_THAN_EQUALS', 'GREATER_THAN', 'GREATER_THAN_EQUALS'])(
    `${PERSON}/155fdc35: refuses a person value with the %s operator, and the error names it`,
    (operator) => {
      expectFeatureRefused(
        withCondition(personComparison(operator, PERMISSIONS_VALUE, OPEN)),
        SET_ENGAGEMENT_STATUS,
        `the ${operator} operator`,
        'EQUALS, NOT_EQUALS, or INTERSECTS',
      );

      expectFeatureRefused(
        withCondition(personComparison(operator, OPEN, PERMISSIONS_VALUE)),
        SET_ENGAGEMENT_STATUS,
        `the ${operator} operator`,
      );
    },
  );

  it.each(['EQUALS', 'NOT_EQUALS', 'INTERSECTS'])(
    `${PERSON}/155fdc35: compiles a person value with the %s operator`,
    (operator) => {
      expect(criterionOf(personComparison(operator, userValue({ type: 'userId', userId: {} }), OPEN))).toEqual({
        kind: 'comparison',
        operator,
        left: { kind: 'person', fact: { kind: 'userId' } },
        right: { kind: 'static', value: 'open' },
      });
    },
  );

  it(`${PERSON}/155fdc35: refuses a regex on a person value`, () => {
    expectFeatureRefused(
      withCondition({ type: 'regex', regex: { value: PERMISSIONS_VALUE, regex: '.*' } }),
      SET_ENGAGEMENT_STATUS,
      'regex',
      'person value',
    );
  });

  const permissionsRefusal = (condition: unknown): string => {
    try {
      compileOrThrow(withCondition(condition));
    } catch (error) {
      return (error as Error).message;
    }

    throw new Error('Compile did not refuse the criterion.');
  };

  it(`${PERSON}/bc576622: the maker group condition compiles to user.permissions, and each group name is a permission slug`, () => {
    expect(criterionOf(IN_GROUP)).toEqual({
      kind: 'comparison',
      operator: 'INTERSECTS',
      left: PERMISSIONS,
      right: { kind: 'static', value: ['sales'] },
    });

    expect(criterionOf(personComparison('INTERSECTS', OPEN, PERMISSIONS_VALUE))).toEqual({
      kind: 'comparison',
      operator: 'INTERSECTS',
      left: { kind: 'static', value: 'open' },
      right: PERMISSIONS,
    });
  });

  it.each(['EQUALS', 'NOT_EQUALS'])(
    `${PERSON}/bfcfbcd8: refuses user.permissions with %s on each side, and the error names the operator`,
    (operator) => {
      const message = `Action Type ${SET_ENGAGEMENT_STATUS} has a comparison of user.permissions with the ${operator} operator. A comparison of user.permissions uses INTERSECTS (holds 1 of these).`;

      expect(permissionsRefusal(personComparison(operator, PERMISSIONS_VALUE, OPEN))).toBe(message);
      expect(permissionsRefusal(personComparison(operator, OPEN, PERMISSIONS_VALUE))).toBe(message);

      expect(
        permissionsRefusal({
          type: 'not',
          not: { condition: { type: 'or', or: { conditions: [personComparison(operator, PERMISSIONS_VALUE, OPEN)] } } },
        }),
      ).toBe(message);
    },
  );

  it.each([
    ['the username', { type: 'userName', userName: {} }, 'userName'],
    ['the group names', { type: 'groupNames', groupNames: {} }, 'group names'],
    [
      'the Organization markings',
      { type: 'organizationMarkingIds', organizationMarkingIds: {} },
      'organizationMarkingIds',
    ],
    ['an unknown person value', { type: 'email', email: {} }, 'email'],
  ])(
    'ontology/action-types/submission-criteria#out-of-scope: refuses a condition on %s of the current user, and the error names it',
    (_name, propertyValue, named) => {
      expectFeatureRefused(
        withCondition(personComparison('EQUALS', userValue(propertyValue), OPEN)),
        SET_ENGAGEMENT_STATUS,
        named,
        'A person value is user.id, user.permissions, or a Person attribute',
      );
    },
  );

  it.each([
    ['a key in the groupIds body', userValue({ type: 'groupIds', groupIds: { groupId: 'g-1' } }), 'groupId'],
    ['a key in the userId body', userValue({ type: 'userId', userId: { id: 'u-2' } }), 'id'],
    [
      'an empty attributeKey',
      userValue({ type: 'userAttributes', userAttributes: { attributeKey: '' } }),
      'attributeKey',
    ],
    [
      'a key beside attributeKey',
      userValue({ type: 'userAttributes', userAttributes: { attributeKey: 'region', namespace: 'x' } }),
      'namespace',
    ],
    ['a key beside the type', userValue({ type: 'groupIds', groupIds: {}, userId: {} }), 'userId'],
    ['a person value that is not an object', userValue('groupIds'), 'not an object'],
    [
      'another user',
      {
        type: 'userProperty',
        userProperty: { userId: { type: 'userId', userId: 'u-2' }, propertyValue: { type: 'groupIds', groupIds: {} } },
      },
      'other than the current user',
    ],
    [
      'a key in currentUser',
      {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: { id: 'u-2' } },
          propertyValue: { type: 'groupIds', groupIds: {} },
        },
      },
      'other than the current user',
    ],
    [
      'a key beside userId',
      {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: {} },
          propertyValue: { type: 'groupIds', groupIds: {} },
          scope: {},
        },
      },
      'scope',
    ],
    [
      'a key beside currentUser',
      {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'currentUser', currentUser: {}, scope: 'x' },
          propertyValue: { type: 'groupIds', groupIds: {} },
        },
      },
      'other than the current user',
    ],
    [
      'a userId type that is not currentUser',
      {
        type: 'userProperty',
        userProperty: {
          userId: { type: 'userId', currentUser: {} },
          propertyValue: { type: 'groupIds', groupIds: {} },
        },
      },
      'other than the current user',
    ],
  ])(`refuses a person value with %s, never reads it as a plain value`, (_name, value, named) => {
    expectFeatureRefused(
      withCondition(personComparison('EQUALS', value, OPEN)),
      SET_ENGAGEMENT_STATUS,
      'Submission criterion',
      named,
    );
  });

  it('ontology/action-types/submission-criteria#out-of-scope: refuses a condition on markings, and the error names it', () => {
    const condition = {
      type: 'markings',
      markings: { filters: { markingTypes: ['MANDATORY'] }, value: { type: 'parameterId', parameterId: 'status' } },
    };

    expectRefused(withCondition(condition), SET_ENGAGEMENT_STATUS, /marking/i);
  });

  it('ontology/action-types/submission-criteria#out-of-scope: refuses a condition on the execution context, and the error names it', () => {
    const condition = { type: 'executionContext', executionContext: { type: 'scenario', scenario: {} } };

    expectRefused(withCondition(condition), SET_ENGAGEMENT_STATUS, /execution ?context/i);
  });

  it('ontology/action-types/submission-criteria#out-of-scope: refuses the IS_OF_OBJECT_TYPE operator, and the error names it', () => {
    const condition = {
      type: 'comparison',
      comparison: {
        operator: 'IS_OF_OBJECT_TYPE',
        left: { type: 'parameterId', parameterId: 'objectToModifyParameter' },
        right: { type: 'staticValue', staticValue: { type: 'objectType', objectType: { objectTypeId: ENGAGEMENT } } },
      },
    };

    expectRefused(withCondition(condition), SET_ENGAGEMENT_STATUS, 'IS_OF_OBJECT_TYPE');
  });

  it('ontology/action-types/submission-criteria#out-of-scope: refuses an Interface parameter Property value, and the error names it', () => {
    const condition = {
      type: 'comparison',
      comparison: {
        operator: 'EQUALS',
        left: {
          type: 'interfaceParameterPropertyValue',
          interfaceParameterPropertyValue: {
            parameterId: 'objectToModifyParameter',
            sharedPropertyTypeRid: `${NS}partyName`,
          },
        },
        right: { type: 'staticValue', staticValue: { type: 'string', string: 'open' } },
      },
    };

    expectRefused(withCondition(condition), SET_ENGAGEMENT_STATUS, /interface ?parameter ?propert/i);
  });

  describe('a static value that a criterion compares with a Decimal', () => {
    function withDecimals(condition: unknown): StoredOntologyVersion {
      const block = withParameter(
        twinActionType('0.4.0', 'set-engagement-status'),
        'price',
        { type: 'decimal', decimal: {} },
        { type: 'range', range: { type: 'range', range: {} } },
      );

      const ir = irWithActions('0.4.0', withCriterion(block, condition));
      const engagement = ir.ontology.objectTypes[ENGAGEMENT];

      if (!engagement) throw new Error('The twin 0.4.0 IR has no Engagement.');

      engagement.objectType.propertyTypes['fee'] = propertyOfType('fee', {
        type: 'decimal',
        decimal: { precision: 10, scale: 2 },
      });

      return stored(ir);
    }

    const compare = (operator: string, left: unknown, right: unknown) => ({
      type: 'comparison',
      comparison: { operator, left, right },
    });

    const price = { type: 'parameterId', parameterId: 'price' };
    const fee = objectProperty('fee');
    const staticOf = (staticValue: unknown) => ({ type: 'staticValue', staticValue });
    const decimal = (value: string) => staticOf({ type: 'decimal', decimal: { decimalValue: value } });

    const criterionOfDecimals = (condition: unknown) =>
      compiledActionType(compileOrThrow(withDecimals(condition)), SET_ENGAGEMENT_STATUS).criteria[0]?.condition;

    it.each([
      [
        'a Decimal parameter on the left',
        compare('EQUALS', price, decimal('1299.90')),
        { kind: 'parameter', parameter: 'price' },
        { kind: 'static', value: '1299.9' },
      ],
      [
        'a Decimal Property on the right',
        compare('GREATER_THAN', decimal('+1.5e3'), fee),
        { kind: 'static', value: '1500' },
        { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'fee' },
      ],
      [
        'a Double static value',
        compare('LESS_THAN', price, staticOf({ type: 'double', double: 0.1 })),
        { kind: 'parameter', parameter: 'price' },
        { kind: 'static', value: '0.1' },
      ],
      [
        'a Decimal list',
        compare('INTERSECTS', fee, staticOf({ type: 'decimalList', decimalList: { decimals: ['1.50', '2'] } })),
        { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'fee' },
        { kind: 'static', value: ['1.5', '2'] },
      ],
    ])(
      'ontology/action-types/action-types#parameters: keeps a static value compared with %s in its plain form',
      (_case, condition, left, right) => {
        expect(criterionOfDecimals(condition)).toEqual({
          kind: 'comparison',
          operator: expect.any(String),
          left,
          right,
        });
      },
    );

    it.each([
      ['a Decimal parameter', compare('EQUALS', price, staticOf({ type: 'string', string: 'cheap' })), '"cheap"'],
      ['a Decimal Property', compare('LESS_THAN', decimal('12..5'), fee), '"12..5"'],
      [
        'a Decimal Property, in a list',
        compare('INTERSECTS', fee, staticOf({ type: 'stringList', stringList: { strings: ['1.5', 'x'] } })),
        '"x"',
      ],
    ])(
      'ontology/action-types/action-types#parameters: refuses a static value that is not a Decimal and that a criterion compares with %s',
      (_case, condition, named) => {
        expectRefused(withDecimals(condition), SET_ENGAGEMENT_STATUS, named, 'is not a Decimal');
      },
    );

    it('ontology/action-types/action-types#parameters: keeps a static null compared with a Decimal, which is no value and not a bad Decimal', () => {
      expect(criterionOfDecimals(compare('EQUALS', fee, staticOf({ type: 'null', null: {} })))).toMatchObject({
        right: { kind: 'static', value: null },
      });
    });

    it('ontology/action-types/action-types#parameters: keeps a static value compared with a String as it is', () => {
      expect(criterionOfDecimals(STATUS_IS_OPEN)).toMatchObject({ right: { kind: 'static', value: 'open' } });
    });
  });
});

describe('Functions and function-backed Actions', () => {
  it('ontology/functions/functions#function-backed-actions: adds 1 parameter for each Function input of close-account-action', () => {
    const compiled = compileOrThrow(twin040());
    const actionType = compiledActionType(compiled, CLOSE_ACCOUNT_ACTION);

    expect(parts(actionType)).toEqual({
      account: { id: 'account', type: { kind: 'object', objectType: ACCOUNT }, required: true },
      reason: { id: 'reason', type: { kind: 'string' }, required: false },
    });

    expect(actionType.logic).toEqual({ kind: 'function', function: 'closeAccount' });
  });

  it('ontology/functions/functions#function-backed-actions: sets the provenance from the Edits type of the Function', () => {
    const fn = editFunction(compileOrThrow(twin040()), 'closeAccount');

    expect(fn.apiName).toBe('closeAccount');
    expect([...fn.parameters.keys()]).toEqual(['account', 'reason']);
    expect(fn.provenance.objectTypes).toEqual(new Set([ACCOUNT]));
    expect(fn.provenance.linkTypes).toEqual(new Set());
  });

  it('ontology/functions/functions#function-backed-actions: adds the Object, struct, and String parameters of set-relationship-action', () => {
    const block = twinActionType('0.6.3', 'set-relationship-action');

    const compiled = compileOrThrow(
      stored(irWithActions('0.6.3', block), { functions: functionsOf(SET_RELATIONSHIP) }),
    );

    expect(parts(compiledActionType(compiled, SET_RELATIONSHIP_ACTION))).toEqual({
      probe: { id: 'probe', type: { kind: 'object', objectType: STRUCT_PROBE }, required: true },
      relationship: {
        id: 'relationship',
        type: {
          kind: 'struct',
          fields: new Map([
            ['label', { type: { kind: 'string' }, required: true }],
            ['since', { type: { kind: 'date' }, required: false }],
          ]),
        },
        required: true,
      },
      mode: { id: 'mode', type: { kind: 'string' }, required: true },
    });

    expect([...(compiled.functions.get('setRelationship')?.parameters.keys() ?? [])]).toEqual([
      'probe',
      'relationship',
      'mode',
    ]);

    expect(editFunction(compiled, 'setRelationship').provenance.objectTypes).toEqual(new Set([STRUCT_PROBE]));
  });

  it('ontology/functions/functions#discovery: each Function holds its own parameters, the description of each input, and its version', () => {
    const described = {
      ...CLOSE_ACCOUNT,
      inputs: CLOSE_ACCOUNT.inputs.map((input) =>
        input.name === 'reason' ? { ...input, description: 'Why the account closes.' } : input,
      ),
    };

    const compiled = compileOrThrow(functionBacked('closeAccount', functionsOf(described)));
    const fn = compiled.functions.get('closeAccount');

    expect(fn?.parameters).toBe(compiledActionType(compiled, CLOSE_ACCOUNT_ACTION).parameters);
    expect(fn?.descriptions).toEqual(new Map([['reason', 'Why the account closes.']]));
    expect(fn?.version).toBe('1.0.0');
  });

  it('keeps the Function bundle, and makes the RID of each Action Type and Function from a UUID v5 in the Ontology RID namespace', () => {
    const compiled = compileOrThrow(twin040());

    expect(compiled.functionBundle).toBe(BUNDLE);

    expect(compiledActionType(compiled, CLOSE_ACCOUNT_ACTION).rid).toBe(
      'ri.actions.main.action-type.c2e94fe7-721f-5e98-b0c8-ea8acb3e93e0',
    );

    expect(compiled.functions.get('closeAccount')?.rid).toBe(
      'ri.function-registry.main.function.93bffdfc-a895-575c-9f23-a2b4d47bc060',
    );
  });

  const v1Inputs: [string, DiscoveredDataType, unknown][] = [
    ['String', { type: 'string', string: {} }, { kind: 'string' }],
    ['Boolean', { type: 'boolean', boolean: {} }, { kind: 'boolean' }],
    ['Integer', { type: 'integer', integer: {} }, { kind: 'integer' }],
    ['Double', { type: 'double', double: {} }, { kind: 'double' }],
    ['Date', { type: 'date', date: {} }, { kind: 'date' }],
    ['Timestamp', { type: 'timestamp', timestamp: {} }, { kind: 'timestamp' }],
    [
      'a list of String',
      { type: 'list', list: { elementsType: { type: 'string', string: {} } } },
      { kind: 'list', element: { kind: 'string' } },
    ],
    ['an Object', { type: 'object', object: { objectTypeId: ACCOUNT } }, { kind: 'object', objectType: ACCOUNT }],
    [
      'a list of Objects',
      { type: 'list', list: { elementsType: { type: 'object', object: { objectTypeId: ACCOUNT } } } },
      { kind: 'objectList', objectType: ACCOUNT },
    ],
  ];

  it.each(v1Inputs)('ontology/functions/functions#code: accepts an input of type %s', (_name, dataType, expected) => {
    const fn = discovered('closeAccount', [{ name: 'value', dataType }], [ACCOUNT]);

    const actionType = compiledActionType(
      compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
      CLOSE_ACCOUNT_ACTION,
    );

    expect(actionType.parameters.get('value')?.type).toEqual(expected);
  });

  it.each([
    ['a list of String', { type: 'list', list: { elementsType: { type: 'string', string: {} } } }],
    [
      'a list of Objects',
      { type: 'list', list: { elementsType: { type: 'object', object: { objectTypeId: ACCOUNT } } } },
    ],
  ])(
    'ontology/action-types/action-types#parameters: gives an input of type %s a list length with no bounds, so it is not required',
    (_name, dataType) => {
      const fn = discovered('closeAccount', [{ name: 'value', dataType: dataType as DiscoveredDataType }], [ACCOUNT]);

      const parameter = compiledActionType(
        compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
        CLOSE_ACCOUNT_ACTION,
      ).parameters.get('value');

      expect(parameter).toMatchObject({ required: false, listLength: {} });
    },
  );

  it.each([
    ['a String', { type: 'string', string: {} }, true],
    [
      'an optional String',
      { type: 'optionalType', optionalType: { wrappedType: { type: 'string', string: {} } } },
      false,
    ],
    ['a list of String', { type: 'list', list: { elementsType: { type: 'string', string: {} } } }, false],
  ])(
    'ontology/functions/functions#function-backed-actions: the allowedValues of %s give oneOf with no other value, and keep its required setting',
    (_name, dataType, required) => {
      const input = unchecked<DiscoveredFunction['inputs'][number]>({
        name: 'stage',
        dataType,
        allowedValues: ['lead', 'won'],
      });

      const fn = discovered('closeAccount', [input], [ACCOUNT]);

      const parameter = compiledActionType(
        compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
        CLOSE_ACCOUNT_ACTION,
      ).parameters.get('stage');

      expect(parameter).toMatchObject({
        required,
        allowed: { kind: 'oneOf', values: ['lead', 'won'], otherValueAllowed: false },
      });
    },
  );

  it('ontology/functions/functions#function-backed-actions: each other input has the default allowed values of its type', () => {
    const fn = discovered('closeAccount', [{ name: 'note', dataType: { type: 'string', string: {} } }], [ACCOUNT]);

    const parameter = compiledActionType(
      compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
      CLOSE_ACCOUNT_ACTION,
    ).parameters.get('note');

    expect(parameter?.allowed).toEqual({ kind: 'text' });
  });

  it.each([
    [
      'an Integer input',
      { type: 'integer', integer: {} },
      ['1'],
      'Only a String or a list of String has allowedValues',
    ],
    ['an empty list of values', { type: 'string', string: {} }, [], 'hold 1 or more values'],
  ])(
    'ontology/functions/functions#function-backed-actions: refuses allowedValues on %s',
    (_name, dataType, allowedValues, message) => {
      const input = unchecked<DiscoveredFunction['inputs'][number]>({ name: 'stage', dataType, allowedValues });

      expectRefused(
        functionBacked('closeAccount', functionsOf(discovered('closeAccount', [input], [ACCOUNT]))),
        'stage',
        message,
      );
    },
  );

  it('ontology/functions/functions#code: refuses a Client that is not the first parameter', () => {
    const fn = {
      ...discovered('closeAccount', [], [ACCOUNT]),
      inputs: [{ name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } }, CLIENT_INPUT],
    };

    expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'closeAccount', 'first parameter');
  });

  it('ontology/functions/functions#code: refuses a durable context input', () => {
    const fn = discovered(
      'closeAccount',
      [{ name: 'ctx', dataType: unchecked<DiscoveredDataType>({ type: 'durableContext', durableContext: {} }) }],
      [ACCOUNT],
    );

    expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'ctx', 'durable context');
  });

  it('ontology/functions/functions#code: accepts an optionalType input, and the parameter is not required', () => {
    const optional = { type: 'optionalType', optionalType: { wrappedType: { type: 'string', string: {} } } };
    const fn = discovered('closeAccount', [{ name: 'note', dataType: optional }], [ACCOUNT]);

    const parameter = compiledActionType(
      compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
      CLOSE_ACCOUNT_ACTION,
    ).parameters.get('note');

    expect(parameter).toMatchObject({ id: 'note', type: { kind: 'string' }, required: false });
  });

  it('ontology/functions/functions#code: accepts a struct input of a functionCustomType in customTypes', () => {
    const customTypes = {
      Relationship: {
        fields: {
          label: { type: 'string', string: {} },
          since: { type: 'optionalType', optionalType: { wrappedType: { type: 'date', date: {} } } },
        },
      },
    };

    const fn = discovered(
      'closeAccount',
      [{ name: 'relationship', dataType: { type: 'functionCustomType', functionCustomType: 'Relationship' } }],
      [ACCOUNT],
      customTypes,
    );

    const parameter = compiledActionType(
      compileOrThrow(functionBacked('closeAccount', functionsOf(fn))),
      CLOSE_ACCOUNT_ACTION,
    ).parameters.get('relationship');

    expect(parameter?.type).toEqual({
      kind: 'struct',
      fields: new Map([
        ['label', { type: { kind: 'string' }, required: true }],
        ['since', { type: { kind: 'date' }, required: false }],
      ]),
    });
  });

  it('ontology/functions/functions#code: refuses an Object input of an Object Type that the Ontology does not have', () => {
    const fn = discovered(
      'closeAccount',
      [{ name: 'probe', dataType: { type: 'object', object: { objectTypeId: STRUCT_PROBE } } }],
      [ACCOUNT],
    );

    expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'probe', STRUCT_PROBE);
  });

  it('ontology/functions/functions#code: refuses a list of Objects of an Object Type that the Ontology does not have', () => {
    const list = { type: 'list', list: { elementsType: { type: 'object', object: { objectTypeId: STRUCT_PROBE } } } };
    const fn = discovered('closeAccount', [{ name: 'probes', dataType: list }], [ACCOUNT]);

    expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'probes', STRUCT_PROBE);
  });

  it('ontology/functions/functions#code: refuses an edited Object Type that the Ontology does not have, and accepts a known one', () => {
    const unknown = discovered(
      'closeAccount',
      [{ name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } }],
      [ACCOUNT, STRUCT_PROBE],
    );

    expectRefused(functionBacked('closeAccount', functionsOf(unknown)), 'closeAccount', STRUCT_PROBE);

    const known = discovered(
      'closeAccount',
      [{ name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } }],
      [ACCOUNT, ENGAGEMENT],
    );

    expect(
      editFunction(compileOrThrow(functionBacked('closeAccount', functionsOf(known))), 'closeAccount').provenance
        .objectTypes,
    ).toEqual(new Set([ACCOUNT, ENGAGEMENT]));
  });

  describe('a struct list input', () => {
    const string = { type: 'string', string: {} };
    const optional = (wrappedType: object) => ({ type: 'optionalType', optionalType: { wrappedType } });

    const row = (extra: Record<string, object> = {}) => ({
      Row: {
        fields: {
          rowId: string,
          label: string,
          count: { type: 'integer', integer: {} },
          note: optional(string),
          op: string,
          ...extra,
        },
        fieldMetadata: {
          rowId: { required: true },
          label: { required: true },
          count: { required: true },
          note: { required: false },
          op: { required: true },
        },
      },
    });

    const rowList = { type: 'list', list: { elementsType: { type: 'functionCustomType', functionCustomType: 'Row' } } };

    const compiledRows = (dataType: object, customTypes: Record<string, object> = row()) => {
      const fn = discovered(
        'applyRowProbes',
        [{ name: 'rows', dataType: unchecked<DiscoveredDataType>(dataType) }],
        [ACCOUNT],
        customTypes,
      );

      return compiledActionType(
        compileOrThrow(functionBacked('applyRowProbes', functionsOf(fn))),
        CLOSE_ACCOUNT_ACTION,
      ).parameters.get('rows');
    };

    const ROWS = {
      id: 'rows',
      type: {
        kind: 'list',
        element: {
          kind: 'struct',
          fields: new Map([
            ['rowId', { type: { kind: 'string' }, required: true }],
            ['label', { type: { kind: 'string' }, required: true }],
            ['count', { type: { kind: 'integer' }, required: true }],
            ['note', { type: { kind: 'string' }, required: false }],
            ['op', { type: { kind: 'string' }, required: true }],
          ]),
        },
      },
      required: false,
      allowed: { kind: 'struct' },
      listLength: {},
    };

    it('ontology/action-types/action-types#parameters: rows: Row[] and rows?: Row[] give 1 list parameter with a struct element', () => {
      expect(compiledRows(rowList)).toEqual(ROWS);
      expect(compiledRows(optional(rowList))).toEqual(ROWS);
    });

    it('a list of an anonymousCustomType gives the same struct element', () => {
      const inline = {
        type: 'list',
        list: { elementsType: { type: 'anonymousCustomType', anonymousCustomType: row()['Row'] } },
      };

      expect(compiledRows(inline, {})).toEqual(ROWS);
    });

    it.each([
      ['inner', { type: 'functionCustomType', functionCustomType: 'Inner' }, 'functionCustomType'],
      ['tags', { type: 'list', list: { elementsType: string } }, 'list'],
      ['account', { type: 'object', object: { objectTypeId: ACCOUNT } }, 'object'],
    ])(
      'ontology/action-types/action-types#parameters, ontology/action-types/action-types#out-of-scope: a field %s of type %j is refused, and the error names the field and its type',
      (name, type, kind) => {
        const fn = discovered(
          'applyRowProbes',
          [{ name: 'rows', dataType: unchecked<DiscoveredDataType>(rowList) }],
          [ACCOUNT],
          row({ [name]: type }),
        );

        expect(() => compileOrThrow(functionBacked('applyRowProbes', functionsOf(fn)))).toThrow(
          `The field ${name} of The input rows of Function applyRowProbes has the type ${kind}. The base type of a struct field is String, Boolean, Integer, Double, Decimal, Date, or Timestamp.`,
        );
      },
    );
  });

  const outsideInputs: [string, DiscoveredDataType, RegExp][] = [
    ['Long', { type: 'long', long: {} }, /long/i],
    ['Attachment', { type: 'attachment', attachment: {} }, /attachment/i],
    ['Media reference', { type: 'mediaReference', mediaReference: {} }, /media ?reference/i],
    ['Object Set', { type: 'objectSet', objectSet: { objectTypeId: ACCOUNT } }, /object ?set/i],
    ['Interface reference', { type: 'interface', interface: { interfaceTypeRid: `${NS}Party` } }, /interface/i],
    [
      'map',
      { type: 'map', map: { keysType: { type: 'string', string: {} }, valuesType: { type: 'string', string: {} } } },
      /map/i,
    ],
  ];

  it.each(outsideInputs)(
    'ontology/functions/functions#code: refuses an input of type %s, and the error names the input',
    (_name, dataType, words) => {
      const fn = discovered('closeAccount', [{ name: 'value', dataType }], [ACCOUNT]);

      expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'closeAccount', 'value', words);
    },
  );

  it('ontology/functions/functions#function-backed-actions: refuses a placeholder when the version has no Function', () => {
    expectRefused(functionBacked('closeAccount'), CLOSE_ACCOUNT_ACTION, 'closeAccount');
  });

  it('ontology/functions/functions#function-backed-actions: refuses a placeholder that names no discovered Function', () => {
    const other = discovered(
      'reopenAccount',
      [{ name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } }],
      [ACCOUNT],
    );

    expectRefused(functionBacked('closeAccount', functionsOf(other)), CLOSE_ACCOUNT_ACTION, 'closeAccount');
  });

  it('ontology/functions/functions#function-backed-actions: refuses a Function input with a type outside V1', () => {
    const fn = discovered('closeAccount', [{ name: 'count', dataType: { type: 'long', long: {} } }], [ACCOUNT]);

    expectRefused(functionBacked('closeAccount', functionsOf(fn)), 'count', /long/i);
  });
});

describe('Allowed values', () => {
  const allowedOf = (block: ActionTypeBlock, id: string) =>
    compiledActionType(compileOrThrow(stored(irWithActions('0.4.0', block))), CREATE_ENGAGEMENT).parameters.get(id)
      ?.allowed;

  const withAllowed = (id: string, type: unknown, allowedValues: unknown) =>
    withParameter(twinActionType('0.4.0', 'create-engagement'), id, type, allowedValues);

  const STRING = { type: 'string', string: {} };
  const EMPTY = { type: 'empty', empty: {} };

  it.each([
    ['oneOf', STRING, { kind: 'oneOf', values: [], otherValueAllowed: false }],
    ['range', { type: 'integer', integer: {} }, { kind: 'range' }],
    ['datetime', { type: 'date', date: {} }, { kind: 'datetime' }],
    ['text', STRING, { kind: 'text' }],
    [
      'objectQuery',
      { type: 'objectReference', objectReference: { objectTypeId: ENGAGEMENT } },
      { kind: 'objectQuery' },
    ],
  ])('service/code-layout#seams: reads an empty %s body as allowed values with no bound', (kind, type, allowed) => {
    expect(allowedOf(withAllowed('value', type, { type: kind, [kind]: EMPTY }), 'value')).toEqual(allowed);
  });

  it('service/code-layout#seams: refuses allowed values of a kind that V1 does not know, and the error names the kinds', () => {
    expectRefused(
      stored(irWithActions('0.4.0', withAllowed('note', STRING, { type: 'madeUp', madeUp: {} }))),
      'has the allowed values madeUp, which V1 does not have. The kinds are oneOf',
    );
  });

  it('service/code-layout#seams: refuses allowed values that do not fit the type of the parameter', () => {
    const block = withAllowed('note', STRING, { type: 'range', range: EMPTY });

    expectRefused(
      stored(irWithActions('0.4.0', block)),
      'has the allowed values range, which do not fit its type string.',
    );
  });
});

describe('Parameter default values', () => {
  const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;

  const display = (block: ActionTypeBlock, id: string) =>
    unchecked<{ prefill?: unknown; visibility?: unknown }>(validationOf(block, id).defaultValidation.display);

  const objectPrefill = (parameterId: string, propertyTypeId: string) => ({
    type: 'objectParameterPropertyValue',
    objectParameterPropertyValue: { parameterId, propertyTypeId },
  });

  const compiledParameters = (block: ActionTypeBlock) =>
    compiledActionType(compileOrThrow(stored(irWithActions('0.7.0', block))), block.actionType.metadata.apiName)
      .parameters;

  it('ontology/action-types/action-types#parameters: the twin 0.7.0 IR holds the 2 default values, and the compile keeps each one on its own parameter', () => {
    expect(display(twinActionType('0.7.0', 'set-account-phase'), 'phase').prefill).toEqual(
      objectPrefill('objectToModifyParameter', 'phase'),
    );

    expect(display(twinActionType('0.7.0', 'set-engagement-status'), 'status').prefill).toEqual(
      objectPrefill('objectToModifyParameter', 'status'),
    );

    const compiled = compileOrThrow(stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }));

    expect(compiledActionType(compiled, SET_ACCOUNT_PHASE).parameters.get('phase')?.defaultValue).toEqual({
      kind: 'objectProperty',
      parameter: 'objectToModifyParameter',
      property: 'phase',
    });

    expect(compiledActionType(compiled, SET_ENGAGEMENT_STATUS).parameters.get('status')?.defaultValue).toEqual({
      kind: 'objectProperty',
      parameter: 'objectToModifyParameter',
      property: 'status',
    });
  });

  it('ontology/action-types/action-types#parameters: a parameter with no default value in the IR holds none', () => {
    const parameters = compiledParameters(twinActionType('0.7.0', 'set-account-phase'));

    expect(parameters.get('objectToModifyParameter')).not.toHaveProperty('defaultValue');

    expect(compiledParameters(twinActionType('0.7.0', 'create-engagement')).get('title')).not.toHaveProperty(
      'defaultValue',
    );
  });

  it('ontology/action-types/action-types#parameters: each parameter takes its own default value, not the default value of another parameter', () => {
    const block = withParameter(
      twinActionType('0.7.0', 'set-account-phase'),
      'label',
      { type: 'string', string: {} },
      { type: 'text', text: { type: 'text', text: {} } },
    );

    display(block, 'label').prefill = objectPrefill('objectToModifyParameter', 'name');

    const parameters = compiledParameters(block);

    expect(parameters.get('label')?.defaultValue).toEqual({
      kind: 'objectProperty',
      parameter: 'objectToModifyParameter',
      property: 'name',
    });

    expect(parameters.get('phase')?.defaultValue).toEqual({
      kind: 'objectProperty',
      parameter: 'objectToModifyParameter',
      property: 'phase',
    });
  });

  it('ontology/action-types/action-types#parameters: reads a default value of an Object parameter that the IR lists after the parameter', () => {
    const block = twinActionType('0.7.0', 'set-account-phase');
    const { parameters } = block.actionType.metadata;

    block.actionType.metadata.parameters = {
      phase: parameters['phase'],
      objectToModifyParameter: parameters['objectToModifyParameter'],
    } as typeof parameters;

    expect(Object.keys(block.actionType.metadata.parameters)).toEqual(['phase', 'objectToModifyParameter']);

    expect(compiledParameters(block).get('phase')?.defaultValue).toEqual({
      kind: 'objectProperty',
      parameter: 'objectToModifyParameter',
      property: 'phase',
    });
  });

  it.each([
    ['a parameter that the Action Type does not have', objectPrefill('nope', 'phase'), 'nope'],
    [
      'a parameter that is not an Object reference',
      objectPrefill('phase', 'phase'),
      'not an Object reference parameter',
    ],
    ['a Property that the Object Type does not have', objectPrefill('objectToModifyParameter', 'nope'), 'nope'],
  ])(
    'ontology/action-types/action-types#parameters: refuses a default value that reads %s',
    (_name, prefill, fragment) => {
      const block = twinActionType('0.7.0', 'set-account-phase');

      display(block, 'phase').prefill = prefill;

      expectRefused(stored(irWithActions('0.7.0', block)), 'phase', fragment);
    },
  );

  it.each([
    'staticValue',
    'staticObject',
    'staticObjectV2',
    'interfaceParameterPropertyValue',
    'interfaceParameterPropertyValueV2',
    'objectQueryPrefill',
    'objectQueryPropertyValue',
    'objectSetRidPrefill',
    'parameterTransformPrefill',
    'redacted',
  ])(
    'ontology/action-types/action-types#parameters, ontology/action-types/action-types#out-of-scope: refuses the default value kind %s, and the error names it',
    (kind) => {
      const block = twinActionType('0.7.0', 'set-account-phase');

      display(block, 'phase').prefill = { type: kind, [kind]: {} };

      expectFeatureRefused(stored(irWithActions('0.7.0', block)), 'phase', `default value kind ${kind}`);
    },
  );
});
