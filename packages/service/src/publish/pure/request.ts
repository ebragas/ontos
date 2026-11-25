import { ApiError, each, type Fallible } from '../../errors/index.ts';
import { isRecord, parseGrantsFile, type GrantsFile, type JsonObject, type JsonValue } from '../../ontology/index.ts';
import type { CheckedFunctions, CheckedRequest, OsdkSet, SchemaMigration } from '../index.ts';
import { migrationOutsideV1 } from '../schema/migrationChecks.ts';

export function* readRequest(body: JsonValue | undefined): Fallible<CheckedRequest, ApiError> {
  const value = isObject(body) ? body : {};
  const product = yield* readProduct(value['product']);
  const ir = yield* readIr(value['ir']);
  const migrations = yield* readMigrations(value['schemaMigrations']);
  const osdkSet = yield* readOsdkSet(value['osdkSet']);
  const grants = yield* readGrantsField(value['grants']);
  const validateOnly = yield* readValidateOnly(value['validateOnly']);
  const functions = value['functions'] === undefined ? undefined : yield* readFunctions(value['functions']);

  return {
    product,
    ir,
    schemaMigrations: { migrations },
    osdkSet,
    grants,
    validateOnly,
    ...(functions === undefined ? {} : { functions }),
  };
}

function* readGrantsField(value: JsonValue | undefined): Fallible<GrantsFile, ApiError> {
  const parsed = parseGrantsFile(value);

  if ('problem' in parsed)
    return yield new ApiError(400, 'Default:InvalidArgument', { part: 'grants', problems: [parsed.problem] });

  return parsed.grants;
}

export function* readProduct(product: JsonValue | undefined): Fallible<string, ApiError> {
  if (typeof product !== 'string' || product === '') return yield missing('product');

  return product;
}

function* readIr(ir: JsonValue | undefined): Fallible<JsonObject, ApiError> {
  if (!isObject(ir)) return yield missing('ir');

  const ontology = ir['ontology'];

  if (!isObject(ontology) || !isObject(ontology['objectTypes']) || !isObject(ontology['actionTypes']))
    return yield missing('ir');

  return ir;
}

function* readMigrations(file: JsonValue | undefined): Fallible<SchemaMigration[], ApiError> {
  const migrations = isRecord(file) ? file['migrations'] : undefined;

  if (!Array.isArray(migrations)) return yield missing('schemaMigrations');

  return yield* each(migrations, readMigration);
}

function* readMigration(migration: JsonValue): Fallible<SchemaMigration, ApiError> {
  if (!isRecord(migration) || typeof migration['type'] !== 'string') return yield missing('schemaMigrations');

  const type = migration['type'];

  const stringField = (name: string): string | undefined => {
    const field = migration[name];

    return typeof field === 'string' ? field : undefined;
  };

  const objectType = stringField('objectType');

  switch (type) {
    case 'dropProperty': {
      const property = stringField('property');

      if (objectType === undefined || property === undefined) return yield missing('schemaMigrations');

      return { type, objectType, property };
    }
    case 'dropAllPatches':
    case 'dropEditHistory':
      if (objectType === undefined) return yield missing('schemaMigrations');

      return { type, objectType };
    case 'dropLinks': {
      const linkType = stringField('linkType');

      if (linkType === undefined) return yield missing('schemaMigrations');

      return { type, linkType };
    }
    case 'renameProperty': {
      const source = stringField('source');
      const target = stringField('target');

      if (objectType === undefined || source === undefined || target === undefined)
        return yield missing('schemaMigrations');

      return { type, objectType, source, target };
    }
    default:
      return yield migrationOutsideV1(type);
  }
}

function* readValidateOnly(validateOnly: JsonValue | undefined): Fallible<boolean, ApiError> {
  if (typeof validateOnly !== 'boolean') return yield missing('validateOnly');

  return validateOnly;
}

function* readOsdkSet(set: JsonValue | undefined): Fallible<OsdkSet, ApiError> {
  if (!isRecord(set)) return yield missing('osdkSet');

  const versions: Record<string, string> = {};

  for (const [name, version] of Object.entries(set)) {
    if (typeof version !== 'string') return yield missing('osdkSet');

    versions[name] = version;
  }

  return versions;
}

function* readFunctions(functions: JsonValue): Fallible<CheckedFunctions, ApiError> {
  if (!isObject(functions) || typeof functions['bundle'] !== 'string') return yield missing('functions');

  const discovered = functions['discovered'];

  if (!Array.isArray(discovered)) return yield missing('functions');

  const checked: JsonObject[] = [];

  for (const f of discovered) {
    if (!isObject(f) || !isObject(f['locator'])) return yield missing('functions');

    checked.push(f);
  }

  return { discovered: checked, bundle: functions['bundle'] };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

function missing(part: string): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { part });
}
