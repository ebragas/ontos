import { type Fallible } from '../../errors/index.ts';
import type {
  CompiledObjectType,
  CompiledProperty,
  CompiledValueType,
  ObjectTypeApiName,
  PropertyApiName,
  ValueTypeApiName,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { objectTypeDisplay, propertyDisplay, propertyStatus } from '../model/display.ts';
import { objectTypeRid, propertyRid } from '../model/entityRids.ts';
import { checkObjectTypeApiName, checkPropertyApiName } from '../model/names.ts';
import { optionalBoolean, status } from '../model/optional.ts';
import { compilePropertyType } from '../model/properties.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from '../model/shape.ts';
import { columnName, tableName } from '../model/tableNames.ts';
import { compilePolicies } from '../policies.ts';
import { compileUniqueness } from '../uniqueness.ts';
import { propertyValueType } from '../valueTypes.ts';
import { splitDerived } from './derived.ts';

const MAX_PROPERTIES = 1500;

export interface DeclaredDerived {
  readonly property: CompiledProperty;
  readonly datasource: JsonRecord;
}

export type DeclaredObjectType = CompiledObjectType<DeclaredDerived>;

export function* compileObjectTypes(
  objectTypes: JsonRecord,
  namespace: string,
  valueTypes: ReadonlyMap<ValueTypeApiName, CompiledValueType>,
): Fallible<
  { objectTypes: Map<ObjectTypeApiName, DeclaredObjectType>; readOnly: Set<ObjectTypeApiName> },
  CompileError
> {
  const compiled = new Map<ObjectTypeApiName, DeclaredObjectType>();
  const readOnly = new Set<ObjectTypeApiName>();

  for (const [key, value] of Object.entries(objectTypes)) {
    const path = `ontology.objectTypes.${key}`;
    const block = yield* record(value, path);

    const compiledType = yield* compileObjectType(
      yield* record(block['objectType'], `${path}.objectType`),
      `${path}.objectType`,
      namespace,
      valueTypes,
    );

    const history = yield* editsHistory(block['entityMetadata'], `${path}.entityMetadata`, compiledType.apiName);
    const split = yield* splitDerived(block['datasources'], compiledType);

    const objectType = yield* compilePolicies(
      block['datasources'],
      history ? { ...split, editsHistory: history } : split,
    );

    if (compiled.has(objectType.apiName)) {
      return yield new CompileError(
        `2 Object Types have the API name ${objectType.apiName}. An Object Type API name is unique.`,
      );
    }

    compiled.set(objectType.apiName, objectType);

    if (yield* turnsOffEdits(block['entityMetadata'], path)) readOnly.add(objectType.apiName);
  }

  return { objectTypes: compiled, readOnly };
}

function* compileObjectType(
  objectType: JsonRecord,
  path: string,
  namespace: string,
  valueTypes: ReadonlyMap<ValueTypeApiName, CompiledValueType>,
): Fallible<DeclaredObjectType, CompileError> {
  const apiName = yield* string(objectType['apiName'], `${path}.apiName`);

  yield* checkObjectTypeApiName(apiName);

  const owner = `Object Type ${apiName}`;

  const display = yield* objectTypeDisplay(objectType, path, owner);
  const objectTypeStatus = yield* status(objectType['status'], `${path}.status`, owner);

  yield* checkNoInterfaces(objectType, path, owner);

  const propertyTypes = yield* record(objectType['propertyTypes'], `${path}.propertyTypes`);
  const count = Object.keys(propertyTypes).length;

  if (count === 0) return yield new CompileError(`${owner} has no Property. An Object Type has at least 1 Property.`);

  if (count > MAX_PROPERTIES)
    return yield new CompileError(`${owner} has ${count} Properties. An Object Type has at most 1,500 Properties.`);

  const primaryKeys = yield* array(objectType['primaryKeys'], `${path}.primaryKeys`);

  if (primaryKeys.length === 0) return yield new CompileError(`${owner} has no primary key.`);

  if (primaryKeys.length > 1)
    return yield new CompileError(
      `${owner} has ${primaryKeys.length} primary key Properties. An Object Type has 1 primary key.`,
    );

  const primaryKey = yield* string(primaryKeys[0], `${path}.primaryKeys.0`);
  const titleValue = objectType['titlePropertyTypeRid'];

  if (!nonEmptyString(titleValue)) return yield new CompileError(`${owner} has no title key.`);

  const titleKey = titleValue;

  const properties = new Map<PropertyApiName, CompiledProperty>();

  for (const [key, value] of Object.entries(propertyTypes)) {
    const property = yield* compileProperty(
      value,
      key,
      `${path}.propertyTypes.${key}`,
      apiName,
      primaryKey,
      namespace,
      valueTypes,
    );

    if (properties.has(property.apiName)) {
      return yield new CompileError(
        `2 Properties of ${owner} have the API name ${property.apiName}. A Property API name is unique within its Object Type.`,
      );
    }

    properties.set(property.apiName, property);
  }

  const key = yield* checkKeys(properties, primaryKey, titleKey, owner);
  const table = tableName(apiName);

  return {
    apiName,
    rid: objectTypeRid(namespace, apiName),
    status: objectTypeStatus,
    display,
    table,
    primaryKey: key,
    titleKey,
    properties,
    derived: new Map(),
    links: new Map(),
    joinTables: [],
    uniqueness: yield* compileUniqueness(apiName, table, properties, key),
  };
}

function* editsHistory(
  value: unknown,
  path: string,
  objectType: ObjectTypeApiName,
): Fallible<CompiledObjectType['editsHistory'], CompileError> {
  if (value === undefined || value === null) return undefined;

  const history = (yield* record(value, path))['editsHistory'];

  if (history === undefined || history === null) return undefined;

  const historyPath = `${path}.editsHistory`;
  const kind = yield* tag(history, historyPath);

  if (kind === 'none') return undefined;

  if (kind !== 'config')
    return yield new CompileError(
      `Object Type ${objectType} has the edit history ${kind}. The edit history is config or none.`,
    );

  const config = yield* record((yield* record(history, historyPath))['config'], `${historyPath}.config`);
  const store = yield* string(config['store'], `${historyPath}.config.store`);

  if (store !== objectType)
    return yield new CompileError(
      `Object Type ${objectType} stores its edit history with ${store}. An Object Type stores its edit history with itself.`,
    );

  return {
    storeAllPreviousProperties:
      (yield* optionalBoolean(
        config['storeAllPreviousProperties'],
        `${historyPath}.config.storeAllPreviousProperties`,
      )) ?? false,
  };
}

function* turnsOffEdits(metadata: unknown, path: string): Fallible<boolean, CompileError> {
  if (!isRecord(metadata)) return false;

  return (yield* optionalBoolean(metadata['arePatchesEnabled'], `${path}.entityMetadata.arePatchesEnabled`)) === false;
}

function* checkKeys(
  properties: ReadonlyMap<PropertyApiName, CompiledProperty>,
  primaryKey: string,
  titleKey: string,
  owner: string,
): Fallible<CompiledProperty, CompileError> {
  const keyProperty = function* (name: string, role: string): Fallible<CompiledProperty, CompileError> {
    const property = properties.get(name);

    if (!property) return yield new CompileError(`The ${role} ${name} of ${owner} is not a Property of it.`);

    return property;
  };

  const key = yield* keyProperty(primaryKey, 'primary key');

  if (key.type.kind !== 'string') {
    return yield new CompileError(
      `The primary key ${primaryKey} of ${owner} has the type ${key.type.kind}. The primary key Property is a String.`,
    );
  }

  const titleKeyType = (yield* keyProperty(titleKey, 'title key')).type.kind;

  if (titleKeyType === 'array' || titleKeyType === 'struct') {
    return yield new CompileError(
      `The title key ${titleKey} of ${owner} is ${titleKeyType === 'array' ? 'an array' : 'a struct'}. The title key Property is never an array or a struct.`,
    );
  }

  return key;
}

function* compileProperty(
  value: unknown,
  key: string,
  path: string,
  objectType: string,
  primaryKey: string,
  namespace: string,
  valueTypes: ReadonlyMap<ValueTypeApiName, CompiledValueType>,
): Fallible<CompiledProperty, CompileError> {
  const property = yield* record(value, path);
  const apiName = property['apiName'];

  if (!nonEmptyString(apiName))
    return yield new CompileError(`Property ${key} of Object Type ${objectType} has no API name.`);

  const owner = `Property ${apiName} of Object Type ${objectType}`;

  yield* checkPropertyApiName(apiName, objectType);

  const display = yield* propertyDisplay(property, path, owner);
  const type = yield* compilePropertyType(property['type'], `${path}.type`, owner);
  const statusOfProperty = yield* propertyStatus(property['status'], `${path}.status`, owner);

  yield* checkNoPropertyFeatures(property, owner);

  const { noNulls, noEmptyCollections } = yield* nullability(
    property['dataConstraints'],
    `${path}.dataConstraints`,
    owner,
  );

  if (noEmptyCollections && !noNulls) {
    return yield new CompileError(
      `${owner} has noEmptyCollections: true without noNulls: true. The Ontology service refuses it.`,
    );
  }

  const valueType = yield* propertyValueType(property, path, owner, type, valueTypes);

  return {
    apiName,
    rid: propertyRid(namespace, objectType, apiName),
    status: statusOfProperty,
    display,
    column: columnName(apiName),
    type,
    required: apiName === primaryKey || noNulls,
    noEmptyCollections,
    searchable: (yield* optionalBoolean(property['indexedForSearch'], `${path}.indexedForSearch`)) ?? true,
    ...(valueType ? { valueType } : {}),
  };
}

function* checkNoPropertyFeatures(property: JsonRecord, owner: string): Fallible<void, CompileError> {
  const shared = property['sharedPropertyTypeApiName'] ?? property['sharedPropertyTypeRid'];

  if (present(shared))
    return yield new CompileError(`${owner} uses the Shared Property ${String(shared)}. V1 has no Shared Properties.`);
}

function* nullability(
  value: unknown,
  path: string,
  owner: string,
): Fallible<{ noNulls: boolean; noEmptyCollections: boolean }, CompileError> {
  if (value === undefined || value === null) return { noNulls: false, noEmptyCollections: false };

  const constraints = yield* record(value, path);

  if (constraints['nullability'] !== undefined && constraints['nullability'] !== null) {
    const raw = constraints['nullability'];

    const label =
      typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : JSON.stringify(raw);

    return yield new CompileError(
      `${owner} has the nullability ${label}. Use nullabilityV2: { noNulls, noEmptyCollections }.`,
    );
  }

  const v2 = constraints['nullabilityV2'];

  if (v2 === undefined || v2 === null) return { noNulls: false, noEmptyCollections: false };

  const flags = yield* record(v2, `${path}.nullabilityV2`);

  return {
    noNulls: (yield* optionalBoolean(flags['noNulls'], `${path}.nullabilityV2.noNulls`)) ?? false,
    noEmptyCollections:
      (yield* optionalBoolean(flags['noEmptyCollections'], `${path}.nullabilityV2.noEmptyCollections`)) ?? false,
  };
}

export function* checkOntologyFeatures(ontology: JsonRecord): Fallible<void, CompileError> {
  const first = function* (field: string): Fallible<string | undefined, CompileError> {
    const value = ontology[field];

    return value === undefined || value === null
      ? undefined
      : Object.keys(yield* record(value, `ontology.${field}`))[0];
  };

  const interfaceType = yield* first('interfaceTypes');

  if (interfaceType !== undefined)
    return yield new CompileError(`The IR has the Interface ${interfaceType}. V1 has no Interfaces.`);

  const sharedProperty = yield* first('sharedPropertyTypes');

  if (sharedProperty !== undefined)
    return yield new CompileError(`The IR has the Shared Property ${sharedProperty}. V1 has no Shared Properties.`);
}

function* checkNoInterfaces(objectType: JsonRecord, path: string, owner: string): Fallible<void, CompileError> {
  const implementations = objectType['implementsInterfaces2'];

  if (present(implementations) && (yield* array(implementations, `${path}.implementsInterfaces2`)).length > 0) {
    const first = yield* record(
      (yield* array(implementations, `${path}.implementsInterfaces2`))[0],
      `${path}.implementsInterfaces2.0`,
    );

    return yield new CompileError(
      `${owner} implements the Interface ${String(first['interfaceTypeApiName'])}. V1 has no Interfaces.`,
    );
  }

  const all = objectType['allImplementsInterfaces'];

  if (present(all) && Object.keys(yield* record(all, `${path}.allImplementsInterfaces`)).length > 0) {
    return yield new CompileError(`${owner} implements an Interface. V1 has no Interfaces.`);
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
