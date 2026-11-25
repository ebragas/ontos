import type { McpCtx } from '../handler/index.ts';
import { ApiError, each, type Fallible } from '../errors/index.ts';
import type { JsonObject, JsonValue } from '../ontology/index.ts';

export type ShortNameArgument = 'objectType' | 'objectSet';

type Resolve = (name: string) => Fallible<string, ApiError>;

export function objectTypeResolver(apiNames: Iterable<string>): Resolve {
  const known = new Set(apiNames);
  const bySuffix = new Map<string, string[]>();

  for (const apiName of known) {
    const short = apiName.slice(apiName.lastIndexOf('.') + 1);

    bySuffix.set(short, [...(bySuffix.get(short) ?? []), apiName]);
  }

  return function* (name): Fallible<string, ApiError> {
    const matches = known.has(name) ? undefined : bySuffix.get(name);

    if (matches === undefined) return name;

    if (matches.length > 1)
      return yield new ApiError(400, 'Default:InvalidArgument', { objectType: name, matches: [...matches].sort() });

    return matches[0] ?? name;
  };
}

const MAX_SHORT_NAME_DEPTH = 64;

export function* resolveObjectSet(resolve: Resolve, tree: JsonValue, depth = 0): Fallible<JsonValue, ApiError> {
  if (depth >= MAX_SHORT_NAME_DEPTH) return yield new ApiError(400, 'Default:InvalidArgument', { part: 'objectSet' });

  if (!isObject(tree)) return tree;

  const set = (value: JsonValue) => resolveObjectSet(resolve, value, depth + 1);

  switch (tree['type']) {
    case 'base':
      return typeof tree['objectType'] === 'string'
        ? { ...tree, objectType: yield* resolve(tree['objectType']) }
        : tree;
    case 'filter':
    case 'searchAround':
      return yield* replaced(tree, 'objectSet', set);
    case 'union':
    case 'intersect':
    case 'subtract':
      return yield* replaced(tree, 'objectSets', function* (sets): Fallible<JsonValue, ApiError> {
        return Array.isArray(sets) ? yield* each(sets, (item) => set(item)) : sets;
      });
    case 'withProperties': {
      const withSet = yield* replaced(tree, 'objectSet', set);

      return yield* replaced(withSet, 'derivedProperties', (definitions) =>
        resolveDefinitions(definitions, set, depth + 1),
      );
    }
    default:
      return tree;
  }
}

function* resolveDefinitions(
  value: JsonValue,
  set: (value: JsonValue) => Fallible<JsonValue, ApiError>,
  depth = 0,
): Fallible<JsonValue, ApiError> {
  if (depth >= MAX_SHORT_NAME_DEPTH) return yield new ApiError(400, 'Default:InvalidArgument', { part: 'objectSet' });

  if (Array.isArray(value)) return yield* each(value, (item) => resolveDefinitions(item, set, depth + 1));

  if (!isObject(value)) return value;

  if (value['type'] === 'selection') return yield* replaced(value, 'objectSet', set);

  const entries = yield* each(Object.entries(value), function* ([key, item]): Fallible<
    readonly [string, JsonValue],
    ApiError
  > {
    return [key, yield* resolveDefinitions(item, set, depth + 1)] as const;
  });

  return Object.fromEntries(entries);
}

export function* withShortNames(
  argument: ShortNameArgument | undefined,
  args: JsonObject,
  ctx: Pick<McpCtx, 'ontology' | 'log'>,
): Fallible<JsonObject, ApiError> {
  if (argument === undefined) return args;

  const resolve = objectTypeResolver(ctx.ontology.objectTypes.keys());

  if (argument === 'objectSet') return yield* replaced(args, 'objectSet', (tree) => resolveObjectSet(resolve, tree));

  const name = args['objectType'];

  if (typeof name !== 'string') return args;

  const apiName = yield* resolve(name);

  ctx.log({ mcp: { apiName } });

  return { ...args, objectType: apiName };
}

function* replaced(
  value: JsonObject,
  key: string,
  change: (member: JsonValue) => Fallible<JsonValue, ApiError>,
): Fallible<JsonObject, ApiError> {
  const member = value[key];

  return member === undefined ? value : { ...value, [key]: yield* change(member) };
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
