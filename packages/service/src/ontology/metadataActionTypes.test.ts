import type { OntologyIr, OntologyIrActionTypeBlockDataV2 } from '@osdk/client.unstable';
import type { ActionTypeV2 } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import type { DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import {
  NS,
  renamed as renamedObjectType,
  twinIr,
  twinObjectType,
  unchecked,
  type TwinVersion,
} from './stored.test-utils.ts';
import { asJson, convert, convertTwin, irWith, linkSide, manyToManyLink, UUID } from '../metadata.test-utils.ts';

type ActionTypeBlock = OntologyIrActionTypeBlockDataV2;

const ACCOUNT = `${NS}Account`;
const TECHNICIAN = `${NS}Technician`;
const CERTIFICATION = `${NS}Certification`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;

function actionTypeOf(metadata: { actionTypes: Record<string, ActionTypeV2> }, apiName: string): ActionTypeV2 {
  const actionType = metadata.actionTypes[apiName];

  if (!actionType) throw new Error(`The converter gave no Action Type ${apiName}.`);

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

  return ir;
}

function renamed(block: ActionTypeBlock, apiName: string): ActionTypeBlock {
  block.actionType.metadata.apiName = apiName;

  return block;
}

function withParameter(
  block: ActionTypeBlock,
  id: string,
  type: unknown,
  allowedValues: unknown,
  required = false,
): ActionTypeBlock {
  const { metadata, actionTypeLogic } = block.actionType;

  metadata.parameters[id] = unchecked({
    id,
    type,
    displayMetadata: { displayName: id, description: '', typeClasses: [] },
  });

  metadata.parameterOrdering.push(id);

  actionTypeLogic.validation.parameterValidations[id] = unchecked({
    defaultValidation: {
      display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
      validation: {
        allowedValues,
        required: required ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
      },
    },
    conditionalOverrides: [],
  });

  return block;
}

const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };

function discovered(functionName: string, inputs: DiscoveredFunction['inputs']): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }, ...inputs],
    output: {
      single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
    },
    customTypes: {},
    ontologyProvenance: { editedObjects: { [ACCOUNT]: {} }, editedLinks: {}, editedInterfaces: {} },
  };
}

function functionsOf(...functions: DiscoveredFunction[]): PublishedFunctions {
  return { discovered: functions, bundle: 'export const functions = {};' };
}

function linkRuleIr(kind: 'addLinkRule' | 'deleteLinkRule'): OntologyIr {
  const block = renamed(twinActionType('0.4.0', 'delete-account'), `${NS}certify`);
  const { metadata, actionTypeLogic } = block.actionType;

  metadata.parameters = {};
  metadata.parameterOrdering = [];

  metadata.displayMetadata.displayName = 'Certify';

  actionTypeLogic.validation.parameterValidations = {};

  withParameter(
    block,
    'technician',
    { type: 'objectReference', objectReference: { objectTypeId: TECHNICIAN } },
    OBJECT_QUERY,
    true,
  );

  withParameter(
    block,
    'certification',
    { type: 'objectReference', objectReference: { objectTypeId: CERTIFICATION } },
    OBJECT_QUERY,
    true,
  );

  actionTypeLogic.logic.rules = [
    unchecked({
      type: kind,
      [kind]: { linkTypeId: 'technician-certifications', sourceObject: 'technician', targetObject: 'certification' },
    }),
  ];

  return irWith({
    objectTypes: [
      renamedObjectType(twinObjectType('Account'), TECHNICIAN),
      renamedObjectType(twinObjectType('Account'), CERTIFICATION),
    ],
    linkTypes: [
      manyToManyLink({
        id: 'technician-certifications',
        a: TECHNICIAN,
        aKey: 'accountId',
        aSide: linkSide('certifications', 'Certification'),
        b: CERTIFICATION,
        bKey: 'accountId',
        bSide: linkSide('technicians', 'Technician'),
      }),
    ],
    actionTypes: [block],
  });
}

describe('the Action Types of the converter output', () => {
  it('ontology/action-types/action-types#parts: the Action Types of the twin 0.7.0 include all rule-backed and function-backed Action Types', () => {
    const { metadata } = convertTwin('0.7.0');

    expect(Object.keys(metadata.actionTypes).sort()).toEqual([
      `${NS}close-account-action`,
      `${NS}copy-account-phase`,
      `${NS}create-account`,
      `${NS}create-engagement`,
      `${NS}create-struct-probe`,
      `${NS}delete-account`,
      `${NS}delete-engagement`,
      `${NS}delete-struct-probe`,
      `${NS}probe-version-check-action`,
      `${NS}set-account-phase`,
      `${NS}set-engagement-status`,
      `${NS}set-relationship-action`,
      `${NS}set-struct-probe-relationship`,
    ]);
  });

  it('ontology/action-types/action-types#parts: an Action Type shows its API name, display name, description, parameters, and rules as operations, and no submission criteria', () => {
    const block = twinActionType('0.4.0', 'create-account');

    block.actionType.metadata.displayMetadata.description = 'Opens a customer account.';

    const name = block.actionType.metadata.parameters['name'];

    if (!name) throw new Error('The twin create-account has no parameter name.');

    name.displayMetadata.description = 'The legal name.';

    const actionType = actionTypeOf(convert(irWithActions('0.4.0', block)).metadata, CREATE_ACCOUNT);

    expect(asJson(actionType)).toEqual({
      apiName: CREATE_ACCOUNT,
      displayName: 'Create Account',
      description: 'Opens a customer account.',
      status: 'ACTIVE',
      parameters: {
        phase: { displayName: 'Phase', dataType: { type: 'string' }, required: false, typeClasses: [] },
        accountId: { displayName: 'Account ID', dataType: { type: 'string' }, required: false, typeClasses: [] },
        name: {
          displayName: 'Name',
          description: 'The legal name.',
          dataType: { type: 'string' },
          required: true,
          typeClasses: [],
        },
      },
      rid: expect.stringMatching(new RegExp(`^ri\\.actions\\.main\\.action-type\\.${UUID}$`)),
      operations: [{ type: 'createObject', objectTypeApiName: ACCOUNT }],
    });
  });

  it('ontology/action-types/action-types#parameters: struct parameters expose their fields on both rule-backed and function-backed Action Types', () => {
    const { metadata } = convertTwin('0.6.3');
    const ruleAction = actionTypeOf(metadata, `${NS}create-struct-probe`);
    const fnAction = actionTypeOf(metadata, `${NS}set-relationship-action`);

    expect(ruleAction.parameters['relationship']?.dataType).toMatchObject({ type: 'struct' });

    const ruleDataType = ruleAction.parameters['relationship']?.dataType as { fields?: { name: string }[] } | undefined;
    const ruleFields = ruleDataType?.fields ?? [];

    expect([...ruleFields].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'label', fieldType: { type: 'string' }, required: false },
      { name: 'since', fieldType: { type: 'date' }, required: false },
    ]);

    const fnDataType = fnAction.parameters['relationship']?.dataType as { fields?: { name: string }[] } | undefined;
    const fnFields = fnDataType?.fields ?? [];

    expect([...fnFields].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'label', fieldType: { type: 'string' }, required: true },
      { name: 'since', fieldType: { type: 'date' }, required: false },
    ]);
  });

  const ALLOWED: Record<string, unknown> = {
    string: { type: 'text', text: { type: 'text', text: {} } },
    boolean: { type: 'boolean', boolean: { type: 'boolean', boolean: {} } },
    integer: { type: 'range', range: { type: 'range', range: {} } },
    double: { type: 'range', range: { type: 'range', range: {} } },
    decimal: { type: 'range', range: { type: 'range', range: {} } },
    date: { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
    timestamp: { type: 'datetime', datetime: { type: 'datetime', datetime: {} } },
  };

  it.each(Object.keys(ALLOWED))(
    'service/publish#what-the-app-publishes: a %s parameter and its list parameter have the OSDK ActionParameterType',
    (base) => {
      const block = twinActionType('0.4.0', 'create-account');

      withParameter(block, 'single', { type: base, [base]: {} }, ALLOWED[base]);

      withParameter(block, 'many', { type: `${base}List`, [`${base}List`]: {} }, ALLOWED[base]);

      const parameters = actionTypeOf(convert(irWithActions('0.4.0', block)).metadata, CREATE_ACCOUNT).parameters;

      expect(parameters['single']?.dataType).toEqual({ type: base });
      expect(parameters['many']?.dataType).toEqual({ type: 'array', subType: { type: base } });
    },
  );

  it('service/publish#what-the-app-publishes: an Object parameter and an Object list parameter have the OSDK ActionParameterType', () => {
    const block = twinActionType('0.4.0', 'create-account');

    withParameter(block, 'one', { type: 'objectReference', objectReference: { objectTypeId: ACCOUNT } }, OBJECT_QUERY);

    withParameter(
      block,
      'related',
      { type: 'objectReferenceList', objectReferenceList: { objectTypeId: ACCOUNT } },
      OBJECT_QUERY,
    );

    const parameters = actionTypeOf(convert(irWithActions('0.4.0', block)).metadata, CREATE_ACCOUNT).parameters;

    expect(parameters['one']?.dataType).toEqual({ type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT });

    expect(parameters['related']?.dataType).toEqual({
      type: 'array',
      subType: { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT },
    });
  });

  it.each([
    ['addLinkRule', 'createLink'],
    ['deleteLinkRule', 'deleteLink'],
  ] as const)(
    "service/publish#what-the-app-publishes: a %s gives a %s operation in the shape of OSDK's LogicRule",
    (kind, type) => {
      const actionType = actionTypeOf(convert(linkRuleIr(kind)).metadata, `${NS}certify`);

      expect(actionType.operations).toEqual([
        {
          type,
          linkTypeApiNameAtoB: 'certifications',
          linkTypeApiNameBtoA: 'technicians',
          aSideObjectTypeApiName: TECHNICIAN,
          bSideObjectTypeApiName: CERTIFICATION,
        },
      ]);
    },
  );

  it('service/publish#what-the-app-publishes: the converter output of the twin 0.7.0 includes ontology block, objectTypes, actionTypes, and empty queryTypes', () => {
    const { metadata } = convertTwin('0.7.0');

    expect(metadata.ontology).toEqual({
      apiName: 'ontology',
      displayName: 'Ontology',
      description: '',
      rid: 'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01',
    });

    expect(Object.keys(metadata.objectTypes).sort()).toEqual([`${NS}Account`, `${NS}Engagement`, `${NS}StructProbe`]);
    expect(Object.keys(metadata.actionTypes)).toHaveLength(13);
    expect(metadata.queryTypes).toEqual({});
  });
});

describe('the function-backed Action Types of the converter output', () => {
  it('ontology/functions/functions#ontology-metadata: the function-backed Action of the twin 0.7.0 exposes its parameters and operations []', () => {
    const { metadata } = convertTwin('0.7.0');

    expect(asJson(actionTypeOf(metadata, CLOSE_ACCOUNT_ACTION))).toEqual({
      apiName: CLOSE_ACCOUNT_ACTION,
      displayName: 'Close account',
      status: 'ACTIVE',
      parameters: {
        account: {
          displayName: 'Account',
          dataType: { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT },
          required: true,
          typeClasses: [],
        },
        reason: { displayName: 'Reason', dataType: { type: 'string' }, required: false, typeClasses: [] },
      },
      rid: expect.stringMatching(new RegExp(`^ri\\.actions\\.main\\.action-type\\.${UUID}$`)),
      operations: [],
    });
  });

  it('ontology/functions/functions#function-backed-actions: each parameter of a function-backed Action has the input name with its first letter in upper case as its display name', () => {
    const displayNames = Object.entries(
      actionTypeOf(convertTwin('0.4.0').metadata, CLOSE_ACCOUNT_ACTION).parameters,
    ).map(([id, p]) => [id, p.displayName]);

    expect(Object.fromEntries(displayNames)).toEqual({ account: 'Account', reason: 'Reason' });

    const block = twinActionType('0.4.0', 'close-account-action');
    const [rule] = block.actionType.actionTypeLogic.logic.rules;

    if (rule?.type !== 'functionRule') throw new Error('The twin close-account-action has no Function rule.');

    rule.functionRule.functionRid = 'renameCustomer';

    const functions = functionsOf(
      discovered('renameCustomer', [{ name: 'customerId', dataType: { type: 'string', string: {} } }]),
    );

    const parameters = actionTypeOf(
      convert(irWithActions('0.4.0', block), { functions }).metadata,
      CLOSE_ACCOUNT_ACTION,
    ).parameters;

    expect(parameters).toEqual({
      customerId: { displayName: 'CustomerId', dataType: { type: 'string' }, required: true, typeClasses: [] },
    });
  });
});

describe('the oneOf allowed values of the Action Type metadata', () => {
  const VALIDATION = {
    defaultValidation: {
      allowedValues: {
        type: 'oneOf',
        options: [
          { displayName: '', value: 'customer' },
          { displayName: '', value: 'prospect' },
        ],
        otherValuesAllowed: false,
      },
    },
  };

  it('ontology/action-types/action-types#parameters: a rule-backed parameter with oneOf allowed values gives them in validation with empty display names, as served by the HTTP API, and a parameter with another kind gives no validation', () => {
    const values = ['customer', 'prospect'].map((value) => ({
      label: value.toUpperCase(),
      value: { type: 'string', string: value },
    }));

    const oneOf = {
      type: 'oneOf',
      oneOf: { type: 'oneOf', oneOf: { labelledValues: values, otherValueAllowed: { allowed: false } } },
    };

    const block = withParameter(
      twinActionType('0.4.0', 'create-account'),
      'choice',
      { type: 'string', string: {} },
      oneOf,
    );

    const { parameters } = actionTypeOf(convert(irWithActions('0.4.0', block)).metadata, CREATE_ACCOUNT);

    expect(parameters['choice']?.validation).toEqual(VALIDATION);
    expect(parameters['name']).not.toHaveProperty('validation');
  });

  it('ontology/action-types/action-types#parameters, ontology/functions/functions#function-backed-actions: a function-backed parameter with allowedValues gives them in validation', () => {
    const block = twinActionType('0.4.0', 'close-account-action');
    const [rule] = block.actionType.actionTypeLogic.logic.rules;

    if (rule?.type !== 'functionRule') throw new Error('The twin close-account-action has no Function rule.');

    rule.functionRule.functionRid = 'setPhase';

    const string = { type: 'string', string: {} };

    const functions = functionsOf(
      discovered('setPhase', [
        { name: 'phase', dataType: string, allowedValues: ['customer', 'prospect'] },
        { name: 'note', dataType: string },
      ]),
    );

    const { parameters } = actionTypeOf(
      convert(irWithActions('0.4.0', block), { functions }).metadata,
      CLOSE_ACCOUNT_ACTION,
    );

    expect(parameters).toEqual({
      phase: {
        displayName: 'Phase',
        dataType: { type: 'string' },
        required: true,
        typeClasses: [],
        validation: VALIDATION,
      },
      note: { displayName: 'Note', dataType: { type: 'string' }, required: true, typeClasses: [] },
    });
  });
});

describe('the parameter IDs of the Action Type metadata', () => {
  it('ontology/functions/functions#function-backed-actions: a Function input named __proto__ is a parameter of the function-backed Action, also after JSON', () => {
    const block = twinActionType('0.4.0', 'close-account-action');
    const [rule] = block.actionType.actionTypeLogic.logic.rules;

    if (rule?.type !== 'functionRule') throw new Error('The twin close-account-action has no Function rule.');

    rule.functionRule.functionRid = 'renameCustomer';

    const functions = functionsOf(
      discovered('renameCustomer', [{ name: '__proto__', dataType: { type: 'string', string: {} } }]),
    );

    const { parameters } = actionTypeOf(
      convert(irWithActions('0.4.0', block), { functions }).metadata,
      CLOSE_ACCOUNT_ACTION,
    );

    expect(Object.keys(parameters)).toEqual(['__proto__']);

    expect(JSON.parse(JSON.stringify(parameters)) as unknown).toEqual(
      JSON.parse(
        '{"__proto__":{"displayName":"__proto__","dataType":{"type":"string"},"required":true,"typeClasses":[]}}',
      ) as unknown,
    );
  });
});

describe('the RIDs of the Action Type metadata', () => {
  it('service/http-api#rids: the twin create-account has the Action Type RID ri.actions.main.action-type.<UUID>', () => {
    const { metadata } = convertTwin('0.4.0');

    expect(actionTypeOf(metadata, CREATE_ACCOUNT).rid).toBe(
      'ri.actions.main.action-type.fe2d7440-47d7-5d5e-9bdb-56f80ec37ea1',
    );
  });

  it('ontology/object-link-types/object-types#out-of-scope: each Action Type of the metadata has the RID of its compiled Action Type', () => {
    const { compiled, metadata } = convertTwin('0.4.0');

    for (const [apiName, actionType] of compiled.actionTypes)
      expect(actionTypeOf(metadata, apiName).rid).toBe(actionType.rid);
  });
});
