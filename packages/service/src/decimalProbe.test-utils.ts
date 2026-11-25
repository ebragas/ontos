import type { OntologyIr } from '@osdk/client.unstable';
import { actionType, deleteRule, parameterValue } from './actions/actions.test-utils.ts';
import { NS, propertyOfType, renamed, twinObjectType, unchecked } from './ontology/stored.test-utils.ts';

export const DECIMAL_PROBE = `${NS}DecimalProbe`;
export const CREATE_DECIMAL_PROBE = `${NS}create-decimal-probe`;
export const MODIFY_DECIMAL_PROBE = `${NS}modify-decimal-probe`;
export const DELETE_DECIMAL_PROBE = `${NS}delete-decimal-probe`;

type PropertyBlock = ReturnType<typeof propertyOfType>;

const decimal = (precision: number, scale: number) => ({ type: 'decimal', decimal: { precision, scale } });

const structField = (apiName: string, fieldType: object) => ({
  apiName,
  displayMetadata: { displayName: apiName },
  typeClasses: [],
  aliases: [],
  fieldType,
});

const fieldOf = (field: string) => ({
  type: 'structParameterFieldValue',
  structParameterFieldValue: { parameterId: 'line', structFieldApiName: field },
});

const STRING = { type: 'string', string: {} };
const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const RANGE = { type: 'range', range: { type: 'range', range: {} } };
const STRUCT = { type: 'struct', struct: { type: 'struct', struct: {} } };
const OBJECT = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const REQUIRED = { type: 'required', required: {} };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

function decimalProbe(): OntologyIr['ontology']['objectTypes'][string] {
  const block = renamed(twinObjectType('Account'), DECIMAL_PROBE);

  const properties = [
    propertyOfType('amount', unchecked<PropertyBlock['type']>(decimal(20, 2))),
    propertyOfType(
      'amounts',
      unchecked<PropertyBlock['type']>({ type: 'array', array: { subtype: decimal(10, 2), reducers: [] } }),
    ),
    propertyOfType(
      'line',
      unchecked<PropertyBlock['type']>({
        type: 'struct',
        struct: { structFields: [structField('sku', STRING), structField('unitPrice', decimal(12, 4))] },
      }),
    ),
  ];

  for (const property of properties) block.objectType.propertyTypes[property.apiName] = property;

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: DECIMAL_PROBE, storeAllPreviousProperties: false } },
  });

  return block;
}

const DECIMALS = {
  amount: { type: { type: 'decimal', decimal: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  amounts: { type: { type: 'decimalList', decimalList: {} }, allowedValues: RANGE, required: NO_LIST_LENGTH },
  line: {
    type: { type: 'struct', struct: { structFieldTypes: { sku: STRING, unitPrice: decimal(12, 4) } } },
    allowedValues: STRUCT,
    required: NOT_REQUIRED,
  },
};

const OBJ = {
  obj: {
    type: { type: 'objectReference', objectReference: { objectTypeId: DECIMAL_PROBE } },
    allowedValues: OBJECT,
    required: REQUIRED,
  },
};

const LINE_VALUES = { line: { sku: fieldOf('sku'), unitPrice: fieldOf('unitPrice') } };
const decimalValues = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, parameterValue(id)]));

function createDecimalProbe(): OntologyIr['ontology']['actionTypes'][string] {
  const parameters = {
    accountId: { type: STRING, allowedValues: TEXT, required: NOT_REQUIRED },
    name: { type: STRING, allowedValues: TEXT, required: NOT_REQUIRED },
    ...DECIMALS,
  };

  const rule = {
    objectTypeId: DECIMAL_PROBE,
    propertyValues: decimalValues(['accountId', 'name', 'amount', 'amounts']),
    structFieldValues: LINE_VALUES,
  };

  return actionType(CREATE_DECIMAL_PROBE, parameters, [{ type: 'addObjectRule', addObjectRule: rule }]);
}

function modifyDecimalProbe(): OntologyIr['ontology']['actionTypes'][string] {
  const rule = {
    objectToModify: 'obj',
    propertyValues: decimalValues(['amount', 'amounts']),
    structFieldValues: LINE_VALUES,
  };

  return actionType(MODIFY_DECIMAL_PROBE, { ...OBJ, ...DECIMALS }, [
    { type: 'modifyObjectRule', modifyObjectRule: rule },
  ]);
}

export function addDecimalProbe(ir: OntologyIr): OntologyIr {
  ir.ontology.objectTypes[DECIMAL_PROBE] = decimalProbe();

  ir.ontology.actionTypes[CREATE_DECIMAL_PROBE] = createDecimalProbe();
  ir.ontology.actionTypes[MODIFY_DECIMAL_PROBE] = modifyDecimalProbe();
  ir.ontology.actionTypes[DELETE_DECIMAL_PROBE] = actionType(DELETE_DECIMAL_PROBE, OBJ, [deleteRule('obj')]);

  return ir;
}

export const EDIT_COUNTS = [
  'addedObjectCount',
  'modifiedObjectsCount',
  'deletedObjectsCount',
  'addedLinksCount',
  'deletedLinksCount',
].map((count) => `edits.${count}`);

export function numberPaths(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === 'number') return [path.join('.')];

  if (value === null || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, child]) => numberPaths(child, [...path, key]));
}
