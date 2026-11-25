import { jsonValueOf } from '../../db/index.ts';
import { parseDecimal } from '../../decimal/index.ts';
import { ApiError, type Fallible } from '../../errors/index.ts';
import type { CheckedEdit, Edit } from '../edit.ts';
import type {
  CompiledConstraint,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  CompiledValueType,
  JsonValue,
  PropertyApiName,
  PropertyType,
  ScalarType,
  UNIQUE_STRING_BYTES,
} from '../../ontology/index.ts';
import { constraintText, valueTypeCheck } from '../../valueTypes/index.ts';
import { objectKey, objectTypeOf, propertyOf } from './shared.ts';

const OBJECTS_LIMIT = 10_000;
const OBJECT_TYPES_LIMIT = 50;
const LINKS_LIMIT = 10_000;
const MAX_STRING_BYTES = 1_000_000;
const MAX_ARRAY_ELEMENTS = 100_000;
const MAX_UNIQUE_STRING_BYTES: typeof UNIQUE_STRING_BYTES = 500;

type EditSource = 'rules' | 'function';

const FUNCTION_VALUE_MESSAGE = 'The Function assigned a value whose type does not match the Property.';

export function* checkValues(
  edits: readonly Edit[],
  ontology: CompiledOntology,
  source: EditSource,
): Fallible<readonly CheckedEdit[], ApiError> {
  yield* checkLimits(edits);

  return yield* checkEditValues(edits, ontology, source);
}

function* checkEditValues(
  edits: readonly Edit[],
  ontology: CompiledOntology,
  source: EditSource,
): Fallible<readonly CheckedEdit[], ApiError> {
  const checked: CheckedEdit[] = [];

  for (const edit of edits) checked.push((yield* checkedEdit(edit, ontology, source)) as CheckedEdit);

  return checked;
}

function* checkedEdit(edit: Edit, ontology: CompiledOntology, source: EditSource): Fallible<Edit, ApiError> {
  if (edit.type !== 'addObject' && edit.type !== 'modifyObject') return edit;

  const objectType = objectTypeOf(ontology, edit.object.objectType);
  const properties = new Map<PropertyApiName, JsonValue>();

  for (const [apiName, value] of edit.properties) {
    properties.set(
      apiName,
      yield* checkProperty(
        objectType,
        propertyOf(objectType, apiName),
        value,
        source,
        edit.unset?.has(apiName) ?? false,
      ),
    );
  }

  if (edit.type === 'addObject') {
    yield* checkProperty(objectType, objectType.primaryKey, edit.object.primaryKey, source);

    for (const property of objectType.properties.values()) {
      if (property.apiName !== objectType.primaryKey.apiName && !edit.properties.has(property.apiName))
        yield* checkProperty(objectType, property, null, source);
    }
  }

  return { ...edit, properties };
}

function* checkLimits(edits: readonly Edit[]): Fallible<void, ApiError> {
  const objects = new Set<string>();
  const objectTypes = new Set<string>();
  let links = 0;

  for (const edit of edits) {
    if (edit.type === 'addObject' || edit.type === 'modifyObject' || edit.type === 'deleteObject') {
      objects.add(objectKey(edit.object));

      objectTypes.add(edit.object.objectType);
    } else {
      links += 1;
    }
  }

  if (objects.size > OBJECTS_LIMIT)
    return yield new ApiError(400, 'OntologyEditsExceededLimit', {
      editsCount: objects.size,
      editsLimit: OBJECTS_LIMIT,
    });

  if (objectTypes.size > OBJECT_TYPES_LIMIT) {
    return yield new ApiError(400, 'OntologyEditsExceededLimit', {
      editsCount: objectTypes.size,
      editsLimit: OBJECT_TYPES_LIMIT,
    });
  }

  if (links > LINKS_LIMIT) {
    return yield new ApiError(400, 'OntologyEditsExceededLimit', {
      editsCount: links,
      editsLimit: LINKS_LIMIT,
    });
  }
}

function* checkProperty(
  objectType: CompiledObjectType,
  property: CompiledProperty,
  value: JsonValue,
  source: EditSource,
  unsetList = false,
): Fallible<JsonValue, ApiError> {
  const refuse = (path: string, rule: string) =>
    invalidValue(objectType.apiName, path, source === 'function' ? FUNCTION_VALUE_MESSAGE : rule);

  if (value === null) {
    if (property.required) return yield refuse(property.apiName, 'A required Property never holds null.');

    return null;
  }

  const checked = checkedValue(property.type, value, property.apiName);

  if ('rule' in checked) return yield refuse(checked.path, checked.rule);

  if (
    typeof checked.value === 'string' &&
    property.type.kind === 'string' &&
    inRule(objectType, property) &&
    new TextEncoder().encode(checked.value).length > MAX_UNIQUE_STRING_BYTES
  ) {
    return yield refuse(
      property.apiName,
      `A String value of a Property in a Uniqueness constraint has at most ${MAX_UNIQUE_STRING_BYTES} bytes in UTF-8.`,
    );
  }

  if (property.noEmptyCollections && Array.isArray(checked.value) && checked.value.length === 0) {
    return yield refuse(
      property.apiName,
      'A required array Property with noEmptyCollections never holds an empty array.',
    );
  }

  if (property.valueType && !unsetList) {
    const failed = checkerOf(property.valueType)(checked.value);

    if (failed) return yield valueTypeRefusal(objectType, property, property.valueType, failed);
  }

  return checked.value;
}

function inRule(objectType: CompiledObjectType, property: CompiledProperty): boolean {
  return objectType.uniqueness.some((rule) => rule.properties.some((member) => member.apiName === property.apiName));
}

const checkers = new WeakMap<CompiledValueType, ReturnType<typeof valueTypeCheck>>();

function checkerOf(valueType: CompiledValueType): ReturnType<typeof valueTypeCheck> {
  let check = checkers.get(valueType);

  if (!check) {
    check = valueTypeCheck(valueType);

    checkers.set(valueType, check);
  }

  return check;
}

function valueTypeRefusal(
  objectType: CompiledObjectType,
  property: CompiledProperty,
  valueType: CompiledValueType,
  failed: CompiledConstraint,
): ApiError {
  const text = `The value of Property ${property.apiName} of Object Type ${objectType.apiName} breaks the value type ${valueType.apiName}: each value ${constraintText(failed.rule)}.`;

  return invalidValue(objectType.apiName, property.apiName, text, failed.failureMessage ?? text);
}

const WRONG_TYPE = 'A value has the base type of its Property.';

function checkedValue(
  type: PropertyType,
  value: JsonValue,
  path: string,
): { readonly value: JsonValue } | { readonly path: string; readonly rule: string } {
  if (type.kind === 'array') {
    if (!Array.isArray(value)) return { path, rule: WRONG_TYPE };

    if (value.length > MAX_ARRAY_ELEMENTS) return { path, rule: 'An array has at most 100,000 elements.' };

    const elements: JsonValue[] = [];

    for (const element of value) {
      if (element === null) return { path, rule: 'An array never holds a null element.' };

      const checked = checkedScalar(type.element, element);

      if ('rule' in checked) return { path, rule: checked.rule };

      elements.push(checked.value);
    }

    return { value: elements };
  }

  if (type.kind === 'struct') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { path, rule: WRONG_TYPE };

    const fields: [string, JsonValue][] = [];

    for (const [field, fieldValue] of Object.entries(value)) {
      const fieldType = type.fields.get(field);

      if (!fieldType) return { path: `${path}.${field}`, rule: 'A struct value has only the fields of its struct.' };

      const checked = fieldValue === null ? { value: null } : checkedScalar(fieldType, fieldValue);

      if ('rule' in checked) return { path: `${path}.${field}`, rule: checked.rule };

      fields.push([field, checked.value]);
    }

    return { value: Object.fromEntries(fields) };
  }

  const checked = checkedScalar(type, value);

  return 'rule' in checked ? { path, rule: checked.rule } : checked;
}

function checkedScalar(type: ScalarType, value: JsonValue): { readonly value: JsonValue } | { readonly rule: string } {
  if (typeof value === 'number' && !Number.isFinite(value)) return { rule: 'A number is never NaN or ±infinity.' };

  if (typeof value === 'string') {
    if (value === '') return { rule: 'A string is never empty.' };

    if (tooLong(value)) return { rule: 'A string has at most 1,000,000 bytes in UTF-8.' };
  }

  if (type.kind === 'decimal') {
    const parsed = parseDecimal(value, type);

    if (parsed.ok) return { value: parsed.text };

    return {
      rule:
        parsed.refusal === 'notDecimal'
          ? WRONG_TYPE
          : `A Decimal value fits the precision ${type.precision} and the scale ${type.scale} of its Property.`,
    };
  }

  const json = jsonValueOf(value, type);

  return json === undefined ? { rule: WRONG_TYPE } : { value: json };
}

function tooLong(value: string): boolean {
  return value.length * 3 > MAX_STRING_BYTES && new TextEncoder().encode(value).length > MAX_STRING_BYTES;
}

function invalidValue(
  objectType: string,
  property: string,
  builderErrorMessage: string,
  userErrorMessage = 'The Action could not apply because a Property value is invalid.',
): ApiError {
  return new ApiError(400, 'ApplyActionFailed', {
    originalErrorName: 'Ontos:InvalidActionPropertyFormat',
    objectType,
    property,
    userErrorMessage,
    builderErrorMessage,
  });
}
