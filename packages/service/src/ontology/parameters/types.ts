import { type Fallible } from '../../errors/index.ts';
import type { AllowedValues } from '../compiled/conditions.ts';
import type { ObjectTypeApiName } from '../compiled/names.ts';
import type { ParameterType } from '../compiled/parameters.ts';
import { CompileError } from '../compiled/stored.ts';
import { record, string, tag, type JsonRecord } from '../model/shape.ts';
import { own, scalarOf, structOf } from './scalars.ts';

const OUTSIDE_TYPES: Readonly<Record<string, string>> = {
  long: 'Long',
  longList: 'Long',
  structList: 'struct list',
  attachment: 'Attachment',
  attachmentList: 'Attachment',
  mediaReference: 'Media reference',
  mediaReferenceList: 'Media reference',
  objectSetRid: 'Object Set',
  interfaceObjectSetRid: 'Object Set',
  interfaceReference: 'Interface reference',
  interfaceReferenceList: 'Interface reference',
  objectTypeReference: 'Object Type reference',
};

const PARAMETER_RULE =
  'A parameter type is a V1 base type other than Struct, a list of one, a struct parameter, an Object reference, or a list of Object references.';

export function* checkObjectType(
  objectType: string,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
  owner: string,
): Fallible<ObjectTypeApiName, CompileError> {
  if (!objectTypes.has(objectType))
    return yield new CompileError(
      `${owner} references the Object Type ${objectType}, which the Ontology does not have.`,
    );

  return objectType;
}

export function* parameterType(
  type: unknown,
  path: string,
  owner: string,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
): Fallible<ParameterType, CompileError> {
  const kind = yield* tag(type, path);
  const body = (yield* record(type, path))[kind];
  const scalar = scalarOf(kind, body);

  if (scalar) return scalar;

  if (kind.endsWith('List')) {
    const element = scalarOf(kind.slice(0, -'List'.length), (yield* record(type, path))[kind]);

    if (element) return { kind: 'list', element };
  }

  switch (kind) {
    case 'objectReference': {
      const reference = yield* record(body, `${path}.${kind}`);
      const create = reference['maybeCreateObjectOption'];

      if (create !== undefined && create !== null) {
        return yield new CompileError(
          `${owner} has maybeCreateObjectOption, the upsert of a Create or modify object rule, which V1 does not have.`,
        );
      }

      return {
        kind: 'object',
        objectType: yield* checkObjectType(
          yield* string(reference['objectTypeId'], `${path}.${kind}.objectTypeId`),
          objectTypes,
          owner,
        ),
      };
    }
    case 'objectReferenceList':
      return {
        kind: 'objectList',
        objectType: yield* checkObjectType(
          yield* string((yield* record(body, `${path}.${kind}`))['objectTypeId'], `${path}.${kind}.objectTypeId`),
          objectTypes,
          owner,
        ),
      };
    case 'struct':
      return yield* structParameter(
        yield* record((yield* record(body, `${path}.struct`))['structFieldTypes'], `${path}.struct.structFieldTypes`),
        `${path}.struct`,
        owner,
      );
  }

  const feature = own(OUTSIDE_TYPES, kind);

  if (feature)
    return yield new CompileError(`${owner} has the parameter type ${kind} (${feature}), which V1 does not have.`);

  return yield new CompileError(`${owner} has the parameter type ${kind}, which V1 does not have. ${PARAMETER_RULE}`);
}

function* structParameter(fieldTypes: JsonRecord, path: string, owner: string): Fallible<ParameterType, CompileError> {
  return yield* structOf(fieldTypes, `${path}.structFieldTypes`, owner);
}

export function defaultAllowed(type: ParameterType): AllowedValues {
  const element = type.kind === 'list' ? type.element : type;

  switch (element.kind) {
    case 'string':
      return { kind: 'text' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'integer':
    case 'double':
    case 'decimal':
      return { kind: 'range' };
    case 'date':
    case 'timestamp':
      return { kind: 'datetime' };
    case 'object':
    case 'objectList':
      return { kind: 'objectQuery' };
    case 'struct':
      return { kind: 'struct' };
  }
}

export function isList(type: ParameterType): boolean {
  return type.kind === 'list' || type.kind === 'objectList';
}
