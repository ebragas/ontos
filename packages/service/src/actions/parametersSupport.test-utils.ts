import type { OntologyIr } from '@osdk/client.unstable';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { NS, twinIr, type Answer } from './actions.test-utils.ts';

export const ACCOUNT = `${NS}Account`;
export const ENGAGEMENT = `${NS}Engagement`;
export const STRUCT_PROBE = `${NS}StructProbe`;
export const CREATE_ACCOUNT = `${NS}create-account`;
export const CREATE_ENGAGEMENT = `${NS}create-engagement`;
export const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
export const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;
export const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
export const SET_RELATIONSHIP_ACTION = `${NS}set-relationship-action`;
export const PHASE_REQUIRED = `${NS}create-account-phase-required`;
export const CHECK_TYPES = `${NS}check-parameter-types`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

function createAccountClone(apiName: string): ActionTypeBlock {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[CREATE_ACCOUNT]);

  if (!block) throw new Error('The twin 0.6.3 IR has no create-account.');

  block.actionType.metadata.apiName = apiName;

  return block;
}

function validationBlock(allowedValues: unknown, required: boolean): unknown {
  return {
    defaultValidation: {
      display: {
        renderHint: { type: 'textInput', textInput: {} },
        visibility: { type: 'editable', editable: {} },
      },
      validation: {
        allowedValues,
        required: required ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
      },
    },
    conditionalOverrides: [],
  };
}

function phaseRequired(): ActionTypeBlock {
  const block = createAccountClone(PHASE_REQUIRED);

  block.actionType.actionTypeLogic.validation.parameterValidations['phase'] = unchecked(
    validationBlock({ type: 'text', text: { type: 'text', text: {} } }, true),
  );

  return block;
}

const RANGE = { type: 'range', range: { type: 'range', range: {} } };

const DATETIME = {
  type: 'datetime',
  datetime: { type: 'datetime', datetime: {} },
};

const EXTRA_PARAMETERS: readonly [string, unknown, unknown][] = [
  ['count', { type: 'integer', integer: {} }, RANGE],
  ['flag', { type: 'boolean', boolean: {} }, { type: 'boolean', boolean: { type: 'boolean', boolean: {} } }],
  ['due', { type: 'date', date: {} }, DATETIME],
  ['at', { type: 'timestamp', timestamp: {} }, DATETIME],
  ['rate', { type: 'decimal', decimal: { precision: 6, scale: 2 } }, RANGE],
  ['tags', { type: 'stringList', stringList: {} }, { type: 'text', text: { type: 'text', text: {} } }],
];

function checkTypes(): ActionTypeBlock {
  const block = createAccountClone(CHECK_TYPES);
  const { metadata, actionTypeLogic } = block.actionType;

  for (const [id, type, allowedValues] of EXTRA_PARAMETERS) {
    metadata.parameters[id] = unchecked({
      id,
      type,
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    metadata.parameterOrdering.push(id);

    actionTypeLogic.validation.parameterValidations[id] = unchecked(validationBlock(allowedValues, false));
  }

  return block;
}

export function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.actionTypes[PHASE_REQUIRED] = phaseRequired();
  ir.ontology.actionTypes[CHECK_TYPES] = checkTypes();

  return ir;
}

export const OBJECT_QUERY = { type: 'objectQueryResult' };

export const structConstraint = (structFields: Record<string, unknown>) => ({
  type: 'struct',
  structFields,
});

export const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };

export const EXECUTE_ALL = {
  mode: 'VALIDATE_AND_EXECUTE',
  returnEdits: 'ALL_V2_WITH_DELETIONS',
};

export const invalidParameterValue = (parameters: Record<string, unknown>): Answer => ({
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'InvalidParameterValue',
    parameters,
  },
});
