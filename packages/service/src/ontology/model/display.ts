import { each, type Fallible } from '../../errors/index.ts';
import type {
  ActionTypeDisplay,
  ObjectTypeDisplay,
  ParameterDisplay,
  ParameterId,
  PropertyDisplay,
  PropertyStatus,
  Status,
  TypeClass,
  Visibility,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { optionalString, status } from './optional.ts';
import { array, record, string, tag, type JsonRecord } from './shape.ts';

export function* objectTypeDisplay(
  objectType: JsonRecord,
  path: string,
  owner: string,
): Fallible<ObjectTypeDisplay, CompileError> {
  const displayPath = `${path}.displayMetadata`;
  const display = yield* record(objectType['displayMetadata'], displayPath);

  const blueprint = yield* record(
    (yield* record(display['icon'], `${displayPath}.icon`))['blueprint'],
    `${displayPath}.icon.blueprint`,
  );

  return {
    displayName: yield* named(display['displayName'], `${owner} has no display name.`),
    pluralDisplayName: yield* named(display['pluralDisplayName'], `${owner} has no plural display name.`),
    description: yield* optionalString(display['description'], `${displayPath}.description`),
    icon: {
      color: yield* string(blueprint['color'], `${displayPath}.icon.blueprint.color`),
      locator: yield* string(blueprint['locator'], `${displayPath}.icon.blueprint.locator`),
    },
    visibility: yield* visibility(display['visibility'], `${displayPath}.visibility`),
  };
}

export function* propertyDisplay(
  property: JsonRecord,
  path: string,
  owner: string,
): Fallible<PropertyDisplay, CompileError> {
  const displayPath = `${path}.displayMetadata`;
  const display = yield* record(property['displayMetadata'], displayPath);
  const type = yield* record(property['type'], `${path}.type`);
  const structFields = new Map<string, readonly TypeClass[]>();

  if (type['type'] === 'struct') {
    const fieldsPath = `${path}.type.struct.structFields`;

    yield* each(
      yield* array((yield* record(type['struct'], `${path}.type.struct`))['structFields'], fieldsPath),
      function* (value, i): Fallible<void, CompileError> {
        const field = yield* record(value, `${fieldsPath}.${i}`);

        structFields.set(
          yield* string(field['apiName'], `${fieldsPath}.${i}.apiName`),
          yield* typeClasses(field['typeClasses'], `${fieldsPath}.${i}.typeClasses`),
        );
      },
    );
  }

  return {
    displayName: yield* named(display['displayName'], `${owner} has no display name.`),
    description: yield* optionalString(display['description'], `${displayPath}.description`),
    visibility: yield* visibility(display['visibility'], `${displayPath}.visibility`),
    typeClasses: yield* typeClasses(property['typeClasses'], `${path}.typeClasses`),
    structFields,
  };
}

export function* propertyStatus(value: unknown, path: string, owner: string): Fallible<PropertyStatus, CompileError> {
  const type = yield* status(value, path, owner);

  if (type !== 'deprecated') return { type };

  const deprecated = yield* record((yield* record(value, path))['deprecated'], `${path}.deprecated`);

  return {
    type,
    message: yield* string(deprecated['message'], `${path}.deprecated.message`),
    deadline: yield* string(deprecated['deadline'], `${path}.deprecated.deadline`),
    replacedBy: yield* optionalString(deprecated['replacedBy'], `${path}.deprecated.replacedBy`),
  };
}

export function* actionTypeDisplay(metadata: JsonRecord, path: string): Fallible<ActionTypeDisplay, CompileError> {
  const displayPath = `${path}.displayMetadata`;
  const display = yield* record(metadata['displayMetadata'], displayPath);
  const parameters = new Map<ParameterId, ParameterDisplay>();

  for (const [id, value] of Object.entries(yield* record(metadata['parameters'], `${path}.parameters`))) {
    const parameterPath = `${path}.parameters.${id}.displayMetadata`;

    const parameter = yield* record(
      (yield* record(value, `${path}.parameters.${id}`))['displayMetadata'],
      parameterPath,
    );

    parameters.set(id, {
      displayName: yield* string(parameter['displayName'], `${parameterPath}.displayName`),
      description: yield* string(parameter['description'], `${parameterPath}.description`),
      typeClasses: yield* typeClasses(parameter['typeClasses'], `${parameterPath}.typeClasses`),
    });
  }

  return {
    displayName: yield* string(display['displayName'], `${displayPath}.displayName`),
    description: yield* optionalString(display['description'], `${displayPath}.description`),
    parameters,
  };
}

export function* actionTypeStatus(value: unknown, path: string): Fallible<Status, CompileError> {
  const kind = yield* tag(value, path);

  return kind === 'active' || kind === 'deprecated' ? kind : 'experimental';
}

function* named(value: unknown, missing: string): Fallible<string, CompileError> {
  if (typeof value !== 'string' || value.length === 0) return yield new CompileError(missing);

  return value;
}

function* typeClasses(value: unknown, path: string): Fallible<TypeClass[], CompileError> {
  return yield* each(yield* array(value, path), function* (entry, i): Fallible<
    { kind: string; name: string },
    CompileError
  > {
    const typeClass = yield* record(entry, `${path}.${i}`);

    return {
      kind: yield* string(typeClass['kind'], `${path}.${i}.kind`),
      name: yield* string(typeClass['name'], `${path}.${i}.name`),
    };
  });
}

function* visibility(value: unknown, path: string): Fallible<Visibility, CompileError> {
  const text = yield* string(value, path);

  if (text === 'NORMAL' || text === 'PROMINENT' || text === 'HIDDEN') return text;

  return yield new CompileError(
    `The IR field ${path} has the visibility ${text}. The visibilities are NORMAL, PROMINENT, and HIDDEN.`,
  );
}
