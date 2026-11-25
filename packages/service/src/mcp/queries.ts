import { queryNotFound, type ApiError, type Fallible } from '../errors/index.ts';
import type {
  CompiledOntology,
  JsonObject,
  ObjectTypeApiName,
  OutputValueType,
  ParameterScalarType,
  ParameterType,
  QueryFunction,
} from '../ontology/index.ts';

function queriesOf(ontology: CompiledOntology): QueryFunction[] {
  return [...ontology.functions.values()]
    .filter((fn): fn is QueryFunction => fn.kind === 'query' && Object.hasOwn(ontology.metadata.queryTypes, fn.apiName))
    .sort((a, b) => (a.apiName < b.apiName ? -1 : 1));
}

export function* describeQuery(
  ontology: CompiledOntology,
  apiName: string | undefined,
): Fallible<JsonObject, ApiError> {
  const queries = queriesOf(ontology);

  if (apiName === undefined)
    return { queries: queries.map((fn) => (fn.description ? `${fn.apiName}: ${fn.description}` : fn.apiName)) };

  const fn = queries.find((candidate) => candidate.apiName === apiName);

  if (!fn) return yield queryNotFound(apiName);

  const inputs = [...fn.parameters.values()].map(({ id, type, required }) => {
    const description = fn.descriptions.get(id);

    return { id, type: typeText(type), required, ...(description ? { description } : {}) };
  });

  return {
    apiName: fn.apiName,
    ...(fn.description ? { description: fn.description } : {}),
    inputs,
    output: `${typeText(fn.output.type)}${fn.output.optional ? ' or null' : ''}`,
  };
}

export function queriesByObjectType(ontology: CompiledOntology): {
  readonly byObjectType: ReadonlyMap<ObjectTypeApiName, readonly QueryFunction[]>;
  readonly other: readonly QueryFunction[];
} {
  const byObjectType = new Map<ObjectTypeApiName, QueryFunction[]>();
  const other: QueryFunction[] = [];

  for (const fn of queriesOf(ontology)) {
    const taken = new Set(
      [...fn.parameters.values()].flatMap(({ type }) =>
        type.kind === 'object' || type.kind === 'objectList' ? [type.objectType] : [],
      ),
    );

    if (taken.size === 0) other.push(fn);

    for (const objectType of taken) byObjectType.set(objectType, [...(byObjectType.get(objectType) ?? []), fn]);
  }

  return { byObjectType, other };
}

const SCALAR_NAMES: Record<ParameterScalarType['kind'], string> = {
  string: 'String',
  boolean: 'Boolean',
  integer: 'Integer',
  double: 'Double',
  decimal: 'Decimal',
  date: 'Date',
  timestamp: 'Timestamp',
};

export function typeText(type: ParameterType | OutputValueType): string {
  switch (type.kind) {
    case 'object':
      return type.objectType;
    case 'objectList':
      return `list of ${type.objectType}`;
    case 'list':
      return `list of ${typeText(type.element)}`;
    case 'struct': {
      const fields = [...type.fields].map(
        ([name, field]) =>
          `${name}${('optional' in field ? field.optional : !field.required) ? '?' : ''}: ${typeText(field.type)}`,
      );

      return `{ ${fields.join(', ')} }`;
    }
    default:
      return SCALAR_NAMES[type.kind];
  }
}
