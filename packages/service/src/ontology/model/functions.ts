import { each, type Fallible } from '../../errors/index.ts';
import type {
  AllowedValues,
  CompiledFunction,
  CompiledParameter,
  FunctionApiName,
  ObjectTypeApiName,
  OutputValueType,
  ParameterId,
  ParameterType,
  QueryOutput,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { scalarOf, structOf } from '../parameters/scalars.ts';
import { checkObjectType, defaultAllowed } from '../parameters/types.ts';
import { functionRid } from './entityRids.ts';
import { optionalBoolean, optionalString } from './optional.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from './shape.ts';

const INPUT_RULE = 'An input has a V1 Action parameter type.';

export const EDITS_RULE = 'Set editsEnabled: true on its defineObject, so @osdk/maker writes arePatchesEnabled: true.';

export function* compileFunctions(
  published: unknown,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
  readOnly: ReadonlySet<ObjectTypeApiName>,
  namespace: string,
  ontologyVersion: number,
): Fallible<ReadonlyMap<FunctionApiName, CompiledFunction>, CompileError> {
  const functions = new Map<FunctionApiName, CompiledFunction>();

  if (published === undefined) return functions;

  const discovered = yield* array((yield* record(published, 'functions'))['discovered'], 'functions.discovered');

  yield* each(discovered, function* (value, index): Fallible<void, CompileError> {
    const path = `functions.discovered.${index}`;
    const fn = yield* record(value, path);
    const locator = yield* record(fn['locator'], `${path}.locator`);

    const apiName = yield* string(
      (yield* record(locator['typescript'], `${path}.locator.typescript`))['functionName'],
      `${path}.locator.typescript.functionName`,
    );

    if (functions.has(apiName))
      return yield new CompileError(
        `2 discovered Functions have the API name ${apiName}. A Function API name is unique.`,
      );

    const customTypes = fn['customTypes'] === undefined ? {} : yield* record(fn['customTypes'], `${path}.customTypes`);
    const inputs = new Map<ParameterId, CompiledParameter>();
    const descriptions = new Map<ParameterId, string>();

    yield* each(yield* array(fn['inputs'], `${path}.inputs`), function* (inputValue, i): Fallible<void, CompileError> {
      const inputPath = `${path}.inputs.${i}`;
      const input = yield* record(inputValue, inputPath);
      const name = yield* string(input['name'], `${inputPath}.name`);
      const dataType = yield* record(input['dataType'], `${inputPath}.dataType`);
      const owner = `The input ${name} of Function ${apiName}`;
      const kind = yield* tag(dataType, `${inputPath}.dataType`);

      if (kind === 'client' && i === 0) return;

      const description = yield* optionalString(input['description'], `${inputPath}.description`);

      if (description !== undefined) descriptions.set(name, description);

      if (kind === 'client')
        return yield new CompileError(
          `${owner} is a Client, and it is not the first parameter. The Client is the first parameter of a Function.`,
        );

      if (kind === 'durableContext')
        return yield new CompileError(
          `${owner} is a durable context, which V1 does not have. The Ontology service gives a Function only a Client.`,
        );

      const optional = dataType['type'] === 'optionalType';

      const type = yield* inputType(
        optional ? yield* unwrap(dataType, `${inputPath}.dataType`) : dataType,
        `${inputPath}.dataType`,
        owner,
        customTypes,
        objectTypes,
      );

      const allowed = yield* inputAllowed(input['allowedValues'], `${inputPath}.allowedValues`, owner, type);

      if (type.kind === 'list' || type.kind === 'objectList') {
        inputs.set(name, { id: name, type, required: false, allowed, listLength: {} });

        return;
      }

      const required = !optional && ((yield* optionalBoolean(input['required'], `${inputPath}.required`)) ?? true);

      inputs.set(name, { id: name, type, required, allowed });
    });

    const base = {
      apiName,
      rid: functionRid(namespace, apiName),
      version: `${ontologyVersion}.0.0`,
      parameters: inputs,
      descriptions,
    };

    const output = yield* record(fn['output'], `${path}.output`);
    const outputPath = `${path}.output.single.dataType`;

    const returned =
      output['type'] === 'void'
        ? undefined
        : yield* record((yield* record(output['single'], `${path}.output.single`))['dataType'], outputPath);

    if ((yield* kindOf(returned, outputPath)) === 'query') {
      const description = yield* optionalString(fn['documentation'], `${path}.documentation`);

      functions.set(apiName, {
        ...base,
        kind: 'query',
        description,
        output: yield* outputOf(returned, outputPath, `Function ${apiName}`, customTypes, objectTypes),
      });

      return;
    }

    const provenance =
      fn['ontologyProvenance'] === undefined
        ? {}
        : yield* record(fn['ontologyProvenance'], `${path}.ontologyProvenance`);

    functions.set(apiName, {
      ...base,
      kind: 'edit',
      provenance: {
        objectTypes: new Set(
          yield* each(
            yield* keys(provenance['editedObjects'], `${path}.ontologyProvenance.editedObjects`),
            function* (o): Fallible<string, CompileError> {
              const objectType = yield* checkObjectType(o, objectTypes, `The Edits type of Function ${apiName}`);

              if (readOnly.has(objectType))
                return yield new CompileError(
                  `The Edits type of Function ${apiName} edits ${objectType}, which turns off edits. ${EDITS_RULE}`,
                );

              return objectType;
            },
          ),
        ),
        linkTypes: new Set(yield* keys(provenance['editedLinks'], `${path}.ontologyProvenance.editedLinks`)),
      },
    });
  });

  return functions;
}

function* kindOf(returned: JsonRecord | undefined, path: string): Fallible<CompiledFunction['kind'], CompileError> {
  if (returned?.['type'] !== 'list') return 'query';

  return (yield* record(
    (yield* record(returned['list'], `${path}.list`))['elementsType'],
    `${path}.list.elementsType`,
  ))['type'] === 'ontologyEdit'
    ? 'edit'
    : 'query';
}

const OUTPUT_RULE =
  'A Query Function returns a String, a Boolean, an Integer, a Double, a Date, a Timestamp, a Decimal, an Object, a struct, or a list of these, or T | undefined.';

function* outputOf(
  returned: JsonRecord | undefined,
  path: string,
  owner: string,
  customTypes: JsonRecord,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
): Fallible<QueryOutput, CompileError> {
  if (!returned)
    return yield new CompileError(
      `${owner} has the output type void, which a Query Function does not have. ${OUTPUT_RULE}`,
    );

  const optional = returned['type'] === 'optionalType';

  return {
    type: yield* outputType(optional ? yield* unwrap(returned, path) : returned, path, owner, customTypes, objectTypes),
    optional,
  };
}

function* outputType(
  dataType: JsonRecord,
  path: string,
  owner: string,
  customTypes: JsonRecord,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
): Fallible<OutputValueType, CompileError> {
  const kind = yield* tag(dataType, path);
  const body = dataType[kind];
  const scalar = scalarOf(kind, body);

  if (scalar) return scalar;

  switch (kind) {
    case 'object':
      return {
        kind: 'object',
        objectType: yield* checkObjectType(
          yield* string((yield* record(body, `${path}.object`))['objectTypeId'], `${path}.object.objectTypeId`),
          objectTypes,
          owner,
        ),
      };
    case 'list': {
      const elementPath = `${path}.list.elementsType`;

      return {
        kind: 'list',
        element: yield* outputType(
          yield* record((yield* record(body, `${path}.list`))['elementsType'], elementPath),
          elementPath,
          owner,
          customTypes,
          objectTypes,
        ),
      };
    }
    case 'anonymousCustomType':
    case 'functionCustomType': {
      const { shape, path: shapePath } = yield* structShape(kind, body, path, owner, customTypes);
      const fields = new Map<string, { type: OutputValueType; optional: boolean }>();

      for (const [name, value] of Object.entries(yield* record(shape['fields'], `${shapePath}.fields`))) {
        const fieldPath = `${shapePath}.fields.${name}`;
        const field = yield* record(value, fieldPath);
        const optional = field['type'] === 'optionalType';

        fields.set(name, {
          type: yield* outputType(
            optional ? yield* unwrap(field, fieldPath) : field,
            fieldPath,
            owner,
            customTypes,
            objectTypes,
          ),
          optional,
        });
      }

      return { kind: 'struct', fields };
    }
  }

  return yield new CompileError(
    `${owner} has the output type ${kind}, which a Query Function does not have. ${OUTPUT_RULE}`,
  );
}

function* keys(value: unknown, path: string): Fallible<string[], CompileError> {
  return value === undefined || value === null ? [] : Object.keys(yield* record(value, path));
}

function* unwrap(dataType: JsonRecord, path: string): Fallible<JsonRecord, CompileError> {
  return yield* record(
    (yield* record(dataType['optionalType'], `${path}.optionalType`))['wrappedType'],
    `${path}.optionalType.wrappedType`,
  );
}

function* inputType(
  dataType: JsonRecord,
  path: string,
  owner: string,
  customTypes: JsonRecord,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
): Fallible<ParameterType, CompileError> {
  const kind = yield* tag(dataType, path);
  const body = dataType[kind];
  const scalar = scalarOf(kind, body);

  if (scalar) return scalar;

  switch (kind) {
    case 'object':
      return {
        kind: 'object',
        objectType: yield* checkObjectType(
          yield* string((yield* record(body, `${path}.object`))['objectTypeId'], `${path}.object.objectTypeId`),
          objectTypes,
          owner,
        ),
      };
    case 'list':
    case 'set':
      return yield* listType(
        yield* record((yield* record(body, `${path}.${kind}`))['elementsType'], `${path}.${kind}.elementsType`),
        `${path}.${kind}.elementsType`,
        owner,
        customTypes,
        objectTypes,
      );
    case 'anonymousCustomType':
    case 'functionCustomType':
      return yield* customType(kind, body, path, owner, customTypes);
  }

  return yield new CompileError(`${owner} has the type ${kind}, which V1 does not have. ${INPUT_RULE}`);
}

function* customType(
  kind: 'anonymousCustomType' | 'functionCustomType',
  body: unknown,
  path: string,
  owner: string,
  customTypes: JsonRecord,
): Fallible<ParameterType, CompileError> {
  const { shape, path: shapePath } = yield* structShape(kind, body, path, owner, customTypes);

  return yield* structType(shape, shapePath, owner);
}

function* structShape(
  kind: 'anonymousCustomType' | 'functionCustomType',
  body: unknown,
  path: string,
  owner: string,
  customTypes: JsonRecord,
): Fallible<{ shape: JsonRecord; path: string }, CompileError> {
  if (kind === 'anonymousCustomType') return { shape: yield* record(body, `${path}.${kind}`), path: `${path}.${kind}` };

  const id = yield* string(body, `${path}.${kind}`);
  const shape = customTypes[id];

  if (!isRecord(shape))
    return yield new CompileError(`${owner} has the custom type ${id}, which the Function's customTypes do not have.`);

  return { shape, path: `customTypes.${id}` };
}

function* listType(
  element: JsonRecord,
  path: string,
  owner: string,
  customTypes: JsonRecord,
  objectTypes: ReadonlySet<ObjectTypeApiName>,
): Fallible<ParameterType, CompileError> {
  const inner = element['type'] === 'optionalType' ? yield* unwrap(element, path) : element;
  const kind = yield* tag(inner, path);
  const scalar = scalarOf(kind, inner[kind]);

  if (scalar) return { kind: 'list', element: scalar };

  if (kind === 'object') {
    return {
      kind: 'objectList',
      objectType: yield* checkObjectType(
        yield* string(
          (yield* record(inner['object'], `${path}.object`))['objectTypeId'],
          `${path}.object.objectTypeId`,
        ),
        objectTypes,
        owner,
      ),
    };
  }

  if (kind === 'anonymousCustomType' || kind === 'functionCustomType') {
    const struct = yield* customType(kind, inner[kind], path, owner, customTypes);

    if (struct.kind === 'struct') return { kind: 'list', element: struct };
  }

  return yield new CompileError(`${owner} is a list of the type ${kind}, which V1 does not have. ${INPUT_RULE}`);
}

function* structType(shape: JsonRecord, path: string, owner: string): Fallible<ParameterType, CompileError> {
  const metadata = isRecord(shape['fieldMetadata']) ? shape['fieldMetadata'] : {};

  return yield* structOf(
    yield* record(shape['fields'], `${path}.fields`),
    `${path}.fields`,
    owner,
    function* (value, fieldPath, name): Fallible<{ type: JsonRecord; required: boolean }, CompileError> {
      const fieldType = yield* record(value, fieldPath);
      const optional = fieldType['type'] === 'optionalType';
      const fieldMetadata = metadata[name];

      const required = isRecord(fieldMetadata)
        ? yield* optionalBoolean(fieldMetadata['required'], `${path}.fieldMetadata.${name}.required`)
        : undefined;

      return { type: optional ? yield* unwrap(fieldType, fieldPath) : fieldType, required: required ?? !optional };
    },
  );
}

function* inputAllowed(
  value: unknown,
  path: string,
  owner: string,
  type: ParameterType,
): Fallible<AllowedValues, CompileError> {
  if (value === undefined) return defaultAllowed(type);

  const values = yield* each(yield* array(value, path), function* (option, i): Fallible<string, CompileError> {
    return yield* string(option, `${path}.${i}`);
  });

  const element = type.kind === 'list' ? type.element : type;

  if (element.kind !== 'string')
    return yield new CompileError(
      `${owner} has allowedValues, and is not a String. Only a String or a list of String has allowedValues.`,
    );

  if (values.length === 0)
    return yield new CompileError(
      `${owner} has allowedValues with no value. The allowedValues of an input hold 1 or more values.`,
    );

  return { kind: 'oneOf', values, otherValueAllowed: false };
}
