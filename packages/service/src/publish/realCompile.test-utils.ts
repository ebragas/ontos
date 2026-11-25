import { expect } from 'vitest';
import type {
  CompiledActionType,
  CompiledLinkType,
  CompiledObjectType,
  CompiledOntology,
  CompiledParameter,
  CompiledProperty,
  CompiledValueType,
  JsonObject,
  JsonValue,
  ParameterType,
  PropertyStatus,
  PropertyType,
  Rule,
  RuleValue,
  Status,
  ValueTypeBase,
  ValueTypeRule,
} from '../ontology/index.ts';

import type { CheckedFunctions } from './index.ts';
import {
  completeWorkOrder,
  EMPTY_BLOCK,
  NAMESPACE,
  ontology,
  OSDK_SET,
  technician,
  workOrder,
} from './publish.test-utils.ts';
import { convertOrThrow } from '../ontology/stored.test-utils.ts';

export interface RealCompile {
  readonly ontology: CompiledOntology;
  readonly ir: JsonObject;
  readonly functions?: CheckedFunctions;
}

export interface RealCompileOptions {
  readonly bundle?: string;
  readonly linkId?: string;
}

export function realCompile(literal: CompiledOntology, options: RealCompileOptions = {}): RealCompile {
  const ir = irFor(literal, options);

  const functions =
    literal.functions.size > 0 ? functionsFor(literal, options.bundle ?? 'export const functions = {};') : undefined;

  const compiled = convertOrThrow(
    { ir, osdkSet: OSDK_SET, validateOnly: false, ...(functions ? { functions } : {}) },
    literal.productRid,
    literal.version,
  );

  expect(planView(compiled), 'The real compile of the IR differs from the test literal.').toEqual(planView(literal));

  return { ontology: compiled, ir, ...(functions ? { functions } : {}) };
}

function planView(compiled: CompiledOntology): unknown {
  return {
    objectTypes: [...compiled.objectTypes.values()].map((type) => ({
      apiName: type.apiName,
      status: type.status,
      table: type.table,
      primaryKey: type.primaryKey.apiName,
      titleKey: type.titleKey,
      editsHistory: type.editsHistory,
      policy: type.policy,
      properties: [...type.properties.values()].map((p) => ({
        apiName: p.apiName,
        status: p.status,
        column: p.column,
        type: p.type,
        required: p.required,
        noEmptyCollections: p.noEmptyCollections,
        searchable: p.searchable,
        policy: p.policy,
        valueType: p.valueType && {
          apiName: p.valueType.apiName,
          version: p.valueType.version,
          baseType: p.valueType.baseType,
          constraints: p.valueType.constraints,
        },
      })),
    })),
    linkTypes: [...compiled.linkTypes.values()].map((link) => ({
      apiName: link.apiName,
      status: link.status,
      storage:
        link.storage.kind === 'foreignKey'
          ? { ...link.storage, property: link.storage.property.apiName }
          : link.storage,
    })),
    actionTypes: [...compiled.actionTypes.values()].map((action) => ({
      apiName: action.apiName,
      status: action.status,
      parameters: action.parameters,
      criteria: action.criteria,
      logic: action.logic,
    })),
    functions: [...compiled.functions.values()].map((fn) => ({
      apiName: fn.apiName,
      inputs: [...fn.parameters.keys()],
      provenance: fn.kind === 'edit' ? fn.provenance : undefined,
    })),
  };
}

function irFor(literal: CompiledOntology, options: RealCompileOptions = {}): JsonObject {
  const objectTypes = Object.fromEntries(
    [...literal.objectTypes.values()].map((type) => [type.apiName, objectTypeBlock(type)]),
  );

  const linkTypes = Object.fromEntries(
    [...literal.linkTypes.values()].map((link) => [kebabCase(link.apiName), linkTypeBlock(link, literal)]),
  );

  const actionTypes = Object.fromEntries(
    [...literal.actionTypes.values()].map((action) => [action.apiName, actionTypeBlock(action, options)]),
  );

  const valueTypes = new Map<string, CompiledValueType>();

  for (const type of literal.objectTypes.values()) {
    for (const p of type.properties.values())
      if (p.valueType) valueTypes.set(`${p.valueType.apiName}@${p.valueType.version}`, p.valueType);
  }

  return {
    ontology: { ...EMPTY_BLOCK, objectTypes, linkTypes, actionTypes },
    importedOntology: EMPTY_BLOCK,
    valueTypes: { valueTypes: [...valueTypes.values()].map(valueTypeBlock) },
    importedValueTypes: { valueTypes: [] },
  };
}

function statusIr(status: Status | PropertyStatus): JsonObject {
  if (typeof status === 'object' && status.type === 'deprecated') {
    const { message, deadline, replacedBy } = status;

    return { type: 'deprecated', deprecated: { message, deadline, ...(replacedBy ? { replacedBy } : {}) } };
  }

  const kind = typeof status === 'object' ? status.type : status;

  return { type: kind, [kind]: {} };
}

const STRING_FLAGS = { isLongText: false, supportsEfficientLeadingWildcard: false, supportsExactMatching: true };

function propertyTypeIr(type: PropertyType): JsonObject {
  switch (type.kind) {
    case 'string':
      return { type: 'string', string: STRING_FLAGS };
    case 'decimal':
      return { type: 'decimal', decimal: { precision: type.precision, scale: type.scale } };
    case 'array':
      return { type: 'array', array: { subtype: propertyTypeIr(type.element) } };
    case 'struct':
      return {
        type: 'struct',
        struct: {
          structFields: [...type.fields].map(([apiName, field]) => ({
            apiName,
            displayMetadata: { displayName: apiName, description: null },
            fieldType: propertyTypeIr(field),
            typeClasses: [],
            aliases: [],
          })),
        },
      };
    default:
      return { type: type.kind, [type.kind]: {} };
  }
}

function propertyBlock(property: CompiledProperty): JsonObject {
  return {
    apiName: property.apiName,
    displayMetadata: { displayName: property.display.displayName, visibility: 'NORMAL' },
    indexedForSearch: property.searchable,
    type: propertyTypeIr(property.type),
    typeClasses: [],
    status: statusIr(property.status),
    dataConstraints: {
      propertyTypeConstraints: (property.valueType?.constraints ?? []).map((c) => ({
        constraints: valueRuleIr(c.rule, property.valueType?.baseType ?? { kind: 'string' }),
        ...failureMessageIr(c.failureMessage),
      })),
      nullabilityV2: { noNulls: property.required, noEmptyCollections: property.noEmptyCollections },
    },
    ...(property.valueType
      ? { valueType: { apiName: property.valueType.apiName, version: property.valueType.version } }
      : {}),
  };
}

function valueTypeBlock(valueType: CompiledValueType): JsonObject {
  const { baseType } = valueType;

  return {
    metadata: {
      apiName: valueType.apiName,
      displayMetadata: { displayName: valueType.displayName, description: valueType.description ?? '' },
      status:
        valueType.status === 'active'
          ? { type: 'active', active: {} }
          : { type: 'deprecated', deprecated: { message: '', deadline: '2027-01-01' } },
    },
    versions: [
      {
        version: valueType.version,
        baseType:
          baseType.kind === 'array'
            ? { type: 'array', array: { elementType: { type: baseType.element, [baseType.element]: {} } } }
            : { type: baseType.kind, [baseType.kind]: {} },
        constraints: valueType.constraints.map((c) => ({
          constraint: { constraint: valueRuleIr(c.rule, baseType), ...failureMessageIr(c.failureMessage) },
        })),
        exampleValues: [],
      },
    ],
  };
}

function failureMessageIr(message: string | undefined): JsonObject {
  return message === undefined ? {} : { failureMessage: { message } };
}

const INNER = { enum: 'oneOf', range: 'range', length: 'length', regex: 'regex', uuid: 'isUuid' } as const;

function valueRuleIr(rule: ValueTypeRule, base: ValueTypeBase): JsonObject {
  const kind = base.kind;

  if (rule.kind === 'array') {
    if (base.kind !== 'array') throw new Error('realCompile has no IR for an array constraint on a scalar base type.');

    const size = {
      ...(rule.minimumSize === undefined ? {} : { minSize: rule.minimumSize }),
      ...(rule.maximumSize === undefined ? {} : { maxSize: rule.maximumSize }),
    };

    return {
      type: 'array',
      array: {
        size,
        elementsUnique: rule.uniqueValues,
        ...(rule.element ? { elementsConstraint: valueRuleIr(rule.element, { kind: base.element }) } : {}),
      },
    };
  }

  const bounds = (
    minimum: JsonValue | undefined,
    maximum: JsonValue | undefined,
    names: readonly [string, string],
  ): JsonObject => ({
    ...(minimum === undefined ? {} : { [names[0]]: minimum }),
    ...(maximum === undefined ? {} : { [names[1]]: maximum }),
  });

  if (kind === 'boolean' && rule.kind === 'enum')
    return { type: kind, [kind]: { allowedValues: rule.options.map((v) => (v ? 'TRUE_VALUE' : 'FALSE_VALUE')) } };

  if ((kind === 'date' || kind === 'timestamp') && rule.kind === 'range')
    return { type: kind, [kind]: { range: bounds(rule.minimum, rule.maximum, ['min', 'max']) } };

  const fields = (): JsonObject => {
    switch (rule.kind) {
      case 'enum':
        return { values: [...rule.options], ...(kind === 'string' ? { useIgnoreCase: false } : {}) };
      case 'range':
        return bounds(rule.minimum, rule.maximum, ['min', 'max']);
      case 'length':
        return bounds(rule.minimum, rule.maximum, ['minSize', 'maxSize']);
      case 'regex':
        return { regexPattern: rule.pattern, usePartialMatch: rule.partialMatch };
      case 'uuid':
        return {};
    }
  };

  const inner = INNER[rule.kind];

  return { type: kind, [kind]: { type: inner, [inner]: fields() } };
}

function objectTypeBlock(type: CompiledObjectType): JsonObject {
  const history = type.editsHistory
    ? {
        type: 'config',
        config: { store: type.apiName, storeAllPreviousProperties: type.editsHistory.storeAllPreviousProperties },
      }
    : { type: 'none', none: {} };

  return {
    objectType: {
      apiName: type.apiName,
      displayMetadata: {
        displayName: type.display.displayName,
        pluralDisplayName: type.display.pluralDisplayName,
        ...(type.display.description === undefined ? {} : { description: type.display.description }),
        icon: { type: 'blueprint', blueprint: { locator: type.display.icon.locator, color: type.display.icon.color } },
        visibility: 'NORMAL',
      },
      primaryKeys: [type.primaryKey.apiName],
      titlePropertyTypeRid: type.titleKey,
      propertyTypes: Object.fromEntries([...type.properties.values()].map((p) => [p.apiName, propertyBlock(p)])),
      status: statusIr(type.status),
      redacted: false,
      implementsInterfaces2: [],
      allImplementsInterfaces: {},
    },
    datasources: type.policy ? [policyDatasource(type)] : [],
    entityMetadata: { arePatchesEnabled: true, editsHistory: history },
  };
}

const OPERATORS = {
  equal: 'EQUAL',
  intersects: 'INTERSECTS',
  subsetOf: 'SUBSET_OF',
  supersetOf: 'SUPERSET_OF',
} as const;

function policyDatasource(type: CompiledObjectType): JsonObject {
  const { policy } = type;

  if (policy?.kind !== 'compare' || policy.object.kind !== 'property' || policy.person.kind === 'attribute') {
    throw new Error(`realCompile has no IR for the object security policy of ${type.apiName}.`);
  }

  const person = policy.person.kind === 'permissions' ? 'groupIds' : 'userId';

  const condition = {
    type: 'comparison',
    comparison: {
      operator: OPERATORS[policy.operator],
      left: { type: 'property', property: policy.object.property },
      right: { type: 'userProperty', userProperty: { type: person, [person]: {} } },
    },
  };

  const group = {
    rid: 'policy',
    security: {
      type: 'granular',
      granular: {
        viewPolicy: {
          granularPolicyCondition: condition,
          additionalMandatory: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} },
        },
      },
    },
    type: { type: 'primaryKey', primaryKey: {} },
    properties: [...type.properties.keys()],
  };

  return {
    datasourceName: type.apiName,
    datasource: {
      type: 'datasetV3',
      datasetV3: { datasetRid: type.apiName, propertySecurityGroups: { groups: [group] } },
    },
  };
}

function kebabCase(apiName: string): string {
  return apiName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function sideIr(apiName: string): JsonObject {
  return {
    apiName,
    displayMetadata: { displayName: apiName, pluralDisplayName: apiName, visibility: 'NORMAL', groupDisplayName: '' },
    typeClasses: [],
  };
}

function linkTypeBlock(link: CompiledLinkType, literal: CompiledOntology): JsonObject {
  const { storage } = link;

  const primaryKeyOf = (apiName: string): string => {
    const type = literal.objectTypes.get(apiName);

    if (!type) throw new Error(`The test literal has no Object Type ${apiName} for the Link Type ${link.apiName}.`);

    return type.primaryKey.apiName;
  };

  const definition =
    storage.kind === 'foreignKey'
      ? {
          type: 'oneToMany',
          oneToMany: {
            cardinalityHint: 'ONE_TO_MANY',
            objectTypeRidOneSide: storage.oneSide,
            objectTypeRidManySide: storage.manySide,
            oneToManyLinkMetadata: sideIr(`${link.apiName}Many`),
            manyToOneLinkMetadata: sideIr(`${link.apiName}One`),
            oneSidePrimaryKeyToManySidePropertyMapping: [
              {
                from: { apiName: primaryKeyOf(storage.oneSide), object: storage.oneSide },
                to: { apiName: storage.property.apiName, object: storage.manySide },
              },
            ],
          },
        }
      : {
          type: 'manyToMany',
          manyToMany: {
            objectTypeRidA: storage.a.objectType,
            objectTypeRidB: storage.b.objectType,
            objectTypeAToBLinkMetadata: sideIr(`${link.apiName}FromA`),
            objectTypeBToALinkMetadata: sideIr(`${link.apiName}FromB`),
          },
        };

  return {
    linkType: { definition, id: kebabCase(link.apiName), status: statusIr(link.status), redacted: false },
    datasources: [],
    entityMetadata: { arePatchesEnabled: true },
  };
}

function parameterTypeIr(type: ParameterType): JsonObject {
  if (type.kind === 'object') return { type: 'objectReference', objectReference: { objectTypeId: type.objectType } };

  throw new Error(`realCompile has no IR for the parameter type ${type.kind}.`);
}

function staticIr(value: JsonValue): JsonObject {
  if (typeof value === 'string') return { type: 'string', string: value };

  throw new Error(`realCompile has no IR for the static value ${JSON.stringify(value)}.`);
}

function ruleValueIr(value: RuleValue, options: RealCompileOptions): JsonObject {
  switch (value.kind) {
    case 'parameter':
      return { type: 'parameterId', parameterId: value.parameter };
    case 'static':
      return { type: 'staticValue', staticValue: staticIr(value.value) };
    case 'uniqueIdentifier':
      return {
        type: 'uniqueIdentifier',
        uniqueIdentifier: { linkId: options.linkId ?? '00000000-0000-4000-8000-000000000001' },
      };
    default:
      throw new Error(`realCompile has no IR for the rule value ${value.kind}.`);
  }
}

function ruleIr(rule: Rule, options: RealCompileOptions): JsonObject {
  const values = (properties: ReadonlyMap<string, RuleValue>) =>
    Object.fromEntries([...properties].map(([name, v]) => [name, ruleValueIr(v, options)]));

  switch (rule.kind) {
    case 'addObject':
      return {
        type: 'addObjectRule',
        addObjectRule: {
          objectTypeId: rule.objectType,
          propertyValues: values(rule.properties),
          structFieldValues: {},
        },
      };
    case 'modifyObject':
      return {
        type: 'modifyObjectRule',
        modifyObjectRule: {
          objectToModify: rule.object,
          propertyValues: values(rule.properties),
          structFieldValues: {},
        },
      };
    default:
      throw new Error(`realCompile has no IR for the rule ${rule.kind}.`);
  }
}

function parameterValidation(parameter: CompiledParameter): JsonObject {
  if (parameter.allowed.kind !== 'objectQuery')
    throw new Error(`realCompile has no IR for the allowed values ${parameter.allowed.kind}.`);

  return {
    defaultValidation: {
      display: { renderHint: { type: 'dropdown', dropdown: {} }, visibility: { type: 'editable', editable: {} } },
      validation: {
        allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
        required: parameter.required ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
      },
    },
    conditionalOverrides: [],
  };
}

function actionTypeBlock(action: CompiledActionType, options: RealCompileOptions): JsonObject {
  if (action.criteria.some((criterion) => criterion.condition.kind !== 'true')) {
    throw new Error(`realCompile has no IR for the submission criteria of ${action.apiName}.`);
  }

  const ruleParameters = action.logic.kind === 'rules' ? [...action.parameters.values()] : [];

  const rules =
    action.logic.kind === 'function'
      ? [
          {
            type: 'functionRule',
            functionRule: { functionRid: action.logic.function, functionVersion: '0.0.0', functionInputValues: {} },
          },
        ]
      : action.logic.rules.map((rule) => ruleIr(rule, options));

  return {
    actionType: {
      actionTypeLogic: {
        logic: { rules },
        validation: {
          actionTypeLevelValidation: { rules: {} },
          parameterValidations: Object.fromEntries(ruleParameters.map((p) => [p.id, parameterValidation(p)])),
          sectionValidations: {},
        },
      },
      metadata: {
        apiName: action.apiName,
        displayMetadata: { displayName: action.display.displayName, description: '' },
        parameterOrdering: ruleParameters.map((p) => p.id),
        parameters: Object.fromEntries(
          ruleParameters.map((p) => [
            p.id,
            {
              id: p.id,
              type: parameterTypeIr(p.type),
              displayMetadata: { displayName: p.id, description: '', typeClasses: [] },
            },
          ]),
        ),
        status: statusIr(action.status),
      },
    },
  };
}

function functionsFor(literal: CompiledOntology, bundle: string): CheckedFunctions {
  const discovered = [...literal.functions.values()].map((fn): JsonObject => {
    if (fn.kind !== 'edit') throw new Error(`realCompile has no Query Function ${fn.apiName}.`);

    const inputs = [...fn.parameters.values()].map(({ id, type, required }) => {
      if (type.kind !== 'object')
        throw new Error(`realCompile has no Object parameter ${id} for the Function ${fn.apiName}.`);

      return { name: id, dataType: { type: 'object', object: { objectTypeId: type.objectType } }, required };
    });

    return {
      locator: { type: 'typescript', typescript: { functionName: fn.apiName } },
      inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }, ...inputs],
      output: {
        type: 'single',
        single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
      },
      customTypes: {},
      ontologyProvenance: {
        editedObjects: Object.fromEntries([...fn.provenance.objectTypes].map((type) => [type, {}])),
        editedLinks: Object.fromEntries([...fn.provenance.linkTypes].map((link) => [link, {}])),
      },
    };
  });

  return { discovered, bundle };
}

export const joinedTechnicianWorkOrders: CompiledLinkType = {
  apiName: 'technicianWorkOrders',
  rid: 'ri.ontology.main.relation.technicianWorkOrders',
  status: 'experimental',
  storage: {
    kind: 'joinTable',
    table: 'technician_work_orders',
    a: { objectType: technician.apiName, column: 'a_technician_id' },
    b: { objectType: workOrder.apiName, column: 'b_work_order_id' },
  },
};

export const joinedOntology = ontology({
  objectTypes: [workOrder, technician],
  linkTypes: [joinedTechnicianWorkOrders],
});

export const namespacedCompleteWorkOrder: CompiledActionType = {
  ...completeWorkOrder,
  apiName: `${NAMESPACE}complete-work-order`,
};
