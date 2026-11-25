import type {
  ParameterEvaluatedConstraint,
  ParameterEvaluationResult,
  StructFieldEvaluationResult,
} from '@osdk/foundry.ontologies';
import { jsonValueOf } from '../../db/index.ts';
import { ApiError, invalidQueryParameterValue, settle, type Fallible } from '../../errors/index.ts';
import type {
  CompiledActionType,
  CompiledOntology,
  CompiledParameter,
  JsonValue,
  ObjectTypeApiName,
  ParameterId,
  ParameterScalarType,
  ParameterType,
  QueryFunction,
  StructParameterType,
} from '../../ontology/index.ts';
import { checkAllowed, MAX_VALUES } from './allowed.ts';
import type { LoadedObject } from '../objects.ts';
import { objectOf, objectTypeOf } from './shared.ts';

export interface ParameterCheck {
  readonly results: ReadonlyMap<ParameterId, ParameterEvaluationResult>;
  readonly values: ReadonlyMap<ParameterId, JsonValue>;
  readonly omitted: ReadonlySet<ParameterId>;
  readonly users: ReadonlyMap<ParameterId, readonly string[]>;
}

export function* checkParameters(
  actionType: CompiledActionType,
  sent: Readonly<Record<ParameterId, JsonValue>>,
  ontology: CompiledOntology,
): Fallible<ParameterCheck, ApiError> {
  const unknown = Object.keys(sent).filter((id) => !actionType.parameters.has(id));

  if (unknown.length > 0) {
    return yield new ApiError(400, 'ParametersNotFound', {
      actionType: actionType.apiName,
      unknownParameterIds: [...unknown].sort(),
      configuredParameterIds: [...actionType.parameters.keys()].sort(),
    });
  }

  return yield* checkEach(actionType.parameters, sent, ontology);
}

export function* checkInputs(
  fn: QueryFunction,
  sent: Readonly<Record<ParameterId, JsonValue>>,
  ontology: CompiledOntology,
): Fallible<ReadonlyMap<ParameterId, JsonValue>, ApiError> {
  const sentOf = (id: ParameterId) => (Object.hasOwn(sent, id) ? sent[id] : undefined);
  const unknownParameters = Object.keys(sent).filter((id) => !fn.parameters.has(id));

  if (unknownParameters.length > 0)
    return yield new ApiError(400, 'UnknownParameter', {
      unknownParameters,
      expectedParameters: [...fn.parameters.keys()],
    });

  const missing = [...fn.parameters.values()]
    .filter(({ id, required }) => required && (sentOf(id) ?? undefined) === undefined)
    .map(({ id }) => id);

  if (missing.length > 0) return yield new ApiError(400, 'MissingParameter', { parameters: missing });

  const values = new Map<ParameterId, JsonValue>();

  for (const parameter of fn.parameters.values()) {
    const { id } = parameter;
    const sentValue = isList(parameter.type) && sentOf(id) === null ? undefined : sentOf(id);

    const checked = settle(
      checkEach(new Map([[id, parameter]]), sentValue === undefined ? {} : { [id]: sentValue }, ontology),
    );

    if (!checked.ok || checked.value.results.get(id)?.result === 'INVALID') {
      return yield invalidQueryParameterValue(
        ontology.metadata.queryTypes[fn.apiName]?.parameters[id]?.dataType,
        id,
        sentValue,
      );
    }

    const value = checked.value.values.get(id);

    if (value !== undefined) values.set(id, value);
  }

  return values;
}

function* checkEach(
  parameters: ReadonlyMap<ParameterId, CompiledParameter>,
  sent: Readonly<Record<ParameterId, JsonValue>>,
  ontology: CompiledOntology,
): Fallible<ParameterCheck, ApiError> {
  const results = new Map<ParameterId, ParameterEvaluationResult>();
  const values = new Map<ParameterId, JsonValue>();
  const users = new Map<ParameterId, readonly string[]>();
  const omitted = new Set<ParameterId>();

  for (const parameter of parameters.values()) {
    const sentValue = Object.hasOwn(sent, parameter.id) ? sent[parameter.id] : undefined;

    if (sentValue === undefined) omitted.add(parameter.id);

    if (sentValue === null && isList(parameter.type)) return yield nullList();

    const typed = yield* checkType(parameter, sentValue ?? undefined, ontology);
    const value = typed.value;

    if (value !== undefined) {
      values.set(parameter.id, value);

      if (parameter.allowed.kind === 'user')
        users.set(
          parameter.id,
          (Array.isArray(value) ? value : [value]).filter((id) => typeof id === 'string'),
        );
    }

    const allowed = checkAllowed(parameter, value);

    results.set(parameter.id, {
      result: (parameter.required && value === undefined) || !allowed.valid || !typed.valid ? 'INVALID' : 'VALID',
      evaluatedConstraints: [...allowed.constraints, ...typed.constraints, ...allowed.last],
      required: parameter.required,
    });
  }

  return { results, values, omitted, users };
}

export function omittedDefaults(
  actionType: CompiledActionType,
  check: ParameterCheck,
): ReadonlyMap<ParameterId, DefaultValue> {
  const defaults = new Map<ParameterId, DefaultValue>();

  for (const parameter of actionType.parameters.values()) {
    if (parameter.defaultValue && check.omitted.has(parameter.id)) defaults.set(parameter.id, parameter.defaultValue);
  }

  return defaults;
}

export function defaultValues(
  actionType: CompiledActionType,
  objects: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>,
): ReadonlyMap<ParameterId, JsonValue> {
  const defaults = new Map<ParameterId, JsonValue>();

  for (const { id, defaultValue } of actionType.parameters.values()) {
    const value = defaultValue && objectOf(objects, defaultValue.parameter)?.properties.get(defaultValue.property);

    if (value !== undefined && value !== null) defaults.set(id, value);
  }

  return defaults;
}

export type DefaultValue = NonNullable<CompiledParameter['defaultValue']>;

interface TypeCheck {
  readonly constraints: ParameterEvaluatedConstraint[];
  readonly valid: boolean;
  readonly value: JsonValue | undefined;
}

function* checkType(
  parameter: CompiledParameter,
  value: JsonValue | undefined,
  ontology: CompiledOntology,
): Fallible<TypeCheck, ApiError> {
  const { id, type } = parameter;

  switch (type.kind) {
    case 'list':
    case 'objectList': {
      const { entries, value: checkedList } =
        value === undefined ? { entries: [], value } : yield* checkList(id, type, value, ontology);

      if (type.kind === 'objectList')
        return { constraints: [{ type: 'objectQueryResult' }], valid: true, value: checkedList };

      if (type.element.kind !== 'struct') return { constraints: [], valid: true, value: checkedList };

      return {
        constraints: [{ type: 'array', entries: entries.length > MAX_VALUES ? [] : entries }],
        valid: entries.every(isValidStruct),
        value: checkedList,
      };
    }
    case 'object':
      if (value !== undefined) yield* checkPrimaryKey(type.objectType, value, ontology);

      return { constraints: [{ type: 'objectQueryResult' }], valid: true, value };
    case 'struct': {
      if (value === undefined) return { constraints: [structResult(type, undefined)], valid: true, value };

      const struct = yield* checkStruct(id, type, value);

      return { constraints: [struct.constraint], valid: isValidStruct(struct.constraint), value: struct.value };
    }
    default: {
      if (value === undefined) return { constraints: [], valid: true, value };

      const json = jsonValueOf(value, type);

      if (json === undefined) return yield invalidParameterValue(id, value, baseTypeName(type));

      return { constraints: [], valid: true, value: json };
    }
  }
}

type ListType = Extract<ParameterType, { kind: 'list' | 'objectList' }>;

function isList(type: ParameterType): type is ListType {
  return type.kind === 'list' || type.kind === 'objectList';
}

function listForm(
  id: ParameterId,
  type: ListType,
  list: JsonValue,
  ontology: CompiledOntology,
): { readonly baseType: string; readonly checkElement: (element: JsonValue) => Fallible<CheckedElement, ApiError> } {
  switch (type.kind) {
    case 'list': {
      const element = type.element;

      if (element.kind === 'struct')
        return { baseType: 'Struct', checkElement: (row) => checkStruct(id, element, row) };

      const baseType = baseTypeName(element);

      return {
        baseType,
        *checkElement(value): Fallible<CheckedElement, ApiError> {
          const json = value === null ? undefined : jsonValueOf(value, element);

          if (json === undefined) return yield invalidParameterValue(id, list, baseType);

          return { value: json };
        },
      };
    }
    case 'objectList': {
      const baseType = `OntologyObject<${type.objectType}>`;

      return {
        baseType,
        *checkElement(element): Fallible<CheckedElement, ApiError> {
          if (element === null) return yield invalidParameterValue(id, list, baseType);

          yield* checkPrimaryKey(type.objectType, element, ontology);

          return { value: element };
        },
      };
    }
  }
}

interface CheckedElement {
  readonly value: JsonValue;
  readonly constraint?: StructConstraint;
}

function* checkList(
  id: ParameterId,
  type: ListType,
  value: JsonValue,
  ontology: CompiledOntology,
): Fallible<{ readonly entries: StructConstraint[]; readonly value: JsonValue[] }, ApiError> {
  const form = listForm(id, type, value, ontology);

  if (!Array.isArray(value)) return yield invalidParameterValue(id, value, form.baseType);

  const entries: StructConstraint[] = [];
  const checkedList: JsonValue[] = [];

  for (const element of value) {
    const { value: json, constraint } = yield* form.checkElement(element);

    checkedList.push(json);

    if (constraint) entries.push(constraint);
  }

  return { entries, value: checkedList };
}

function* checkStruct(
  id: ParameterId,
  type: StructParameterType,
  value: JsonValue,
): Fallible<Required<CheckedElement>, ApiError> {
  if (!isObject(value) || Object.keys(value).some((field) => !type.fields.has(field)))
    return yield invalidParameterValue(id, value);

  const checkedFields: Record<string, JsonValue> = { ...value };

  for (const [name, field] of type.fields) {
    const fieldValue = fieldOf(value, name);

    if (fieldValue === undefined || fieldValue === null) continue;

    const json = jsonValueOf(fieldValue, field.type);

    if (json === undefined) return yield invalidParameterValue(`${id}.${name}`, fieldValue, baseTypeName(field.type));

    checkedFields[name] = json;
  }

  for (const [name, field] of type.fields) {
    if (field.required && fieldOf(value, name) === undefined) return yield invalidParameterValue(id, value);
  }

  return {
    value: checkedFields,
    constraint: structResult(type, value),
  };
}

type StructConstraint = Extract<ParameterEvaluatedConstraint, { type: 'struct' }>;

function isValidStruct(constraint: StructConstraint): boolean {
  return Object.values(constraint.structFields).every((field) => field.result === 'VALID');
}

function structResult(
  type: StructParameterType,
  value: { readonly [key: string]: JsonValue } | undefined,
): StructConstraint {
  const structFields: Record<string, StructFieldEvaluationResult> = {};

  for (const [name, field] of type.fields) {
    const fieldValue = value && fieldOf(value, name);
    const result = field.required && (fieldValue === undefined || fieldValue === null) ? 'INVALID' : 'VALID';

    structFields[name] = { result, evaluatedConstraints: [], required: field.required };
  }

  return { type: 'struct', structFields };
}

function* checkPrimaryKey(
  objectType: ObjectTypeApiName,
  value: JsonValue,
  ontology: CompiledOntology,
): Fallible<void, ApiError> {
  if (jsonValueOf(value, { kind: 'string' }) !== undefined) return;

  return yield new ApiError(400, 'InvalidPropertyValue', {
    propertyBaseType: 'String',
    property: objectTypeOf(ontology, objectType).primaryKey.apiName,
    propertyValue: value,
  });
}

function nullList(): ApiError {
  return new ApiError(400, 'ApplyActionFailed', {
    originalErrorName: 'Ontos:SingletonValueForListParameter',
    userErrorMessage: 'The Action could not apply because of an invalid list parameter.',
    builderErrorMessage: 'A list parameter received a single value instead of a list.',
  });
}

function invalidParameterValue(parameterId: string, parameterValue: JsonValue, parameterBaseType?: string): ApiError {
  return new ApiError(400, 'InvalidParameterValue', {
    ...(parameterBaseType === undefined ? {} : { parameterBaseType }),
    parameterId,
    parameterValue,
  });
}

function baseTypeName(type: ParameterScalarType): string {
  switch (type.kind) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'integer':
      return 'Integer';
    case 'double':
      return 'Double';
    case 'decimal':
      return 'Decimal';
    case 'date':
      return 'LocalDate';
    case 'timestamp':
      return 'Timestamp';
  }
}

function fieldOf(value: { readonly [key: string]: JsonValue }, name: string): JsonValue | undefined {
  return Object.hasOwn(value, name) ? value[name] : undefined;
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
