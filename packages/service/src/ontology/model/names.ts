import { VERSION_COLUMN, type Fallible } from '../../errors/index.ts';
import type { ActionTypeApiName } from '../compiled/names.ts';
import { CompileError } from '../compiled/stored.ts';
import { checkReserved } from './memberNames.ts';
import { columnName, tableName } from './tableNames.ts';

const MAX_LENGTH = 100;

function* checkVersionColumn(apiName: string, name: string, what: string): Fallible<void, CompileError> {
  if (name === VERSION_COLUMN) {
    return yield new CompileError(
      `The ${what} ${apiName} gives the name ${name}, which is the name of the hidden version column. An API name never gives it.`,
    );
  }
}

function* checkLength(apiName: string, what: string, rule: string): Fallible<void, CompileError> {
  if (apiName.length < 1 || apiName.length > MAX_LENGTH) {
    return yield new CompileError(`The ${what} ${apiName} has ${apiName.length} characters. ${rule}`);
  }
}

const API_NAMESPACE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.$/u;

function splitApiName(apiName: string): { namespace: string; part: string } {
  const last = apiName.lastIndexOf('.');

  return { namespace: apiName.slice(0, last + 1), part: apiName.slice(last + 1) };
}

function* checkApiNamespace(apiName: string, what: string): Fallible<string, CompileError> {
  const { namespace, part } = splitApiName(apiName);

  if (!API_NAMESPACE.test(namespace)) {
    return yield new CompileError(
      `The ${what} ${apiName} has the API namespace "${namespace}". An API namespace matches ${API_NAMESPACE.source}, and the part after it is the text after the last dot.`,
    );
  }

  return part;
}

export function camelCaseOf(id: string): string {
  return id.replace(/-(.?)/g, (_match, next: string) => next.toUpperCase());
}

export function publishedActionTypeNames(
  apiNames: Iterable<ActionTypeApiName>,
): ReadonlyMap<string, ActionTypeApiName> {
  const published = new Map<string, ActionTypeApiName | undefined>();

  for (const apiName of apiNames) {
    for (const name of [camelCaseOf(apiName), camelCaseOf(splitApiName(apiName).part)]) {
      published.set(name, published.has(name) && published.get(name) !== apiName ? undefined : apiName);
    }
  }

  return new Map(
    [...published].flatMap(([name, apiName]) => (apiName === undefined ? [] : [[name, apiName] as const])),
  );
}

const OBJECT_TYPE_RULE =
  'The part after the API namespace starts with an uppercase letter and has only letters and digits. The full API name has 1 to 100 characters.';

export function* checkObjectTypeApiName(apiName: string): Fallible<void, CompileError> {
  const what = 'Object Type API name';

  yield* checkVersionColumn(apiName, tableName(apiName), what);

  yield* checkLength(apiName, what, OBJECT_TYPE_RULE);

  const part = yield* checkApiNamespace(apiName, what);

  if (!/^[A-Z][A-Za-z0-9]*$/.test(part))
    return yield new CompileError(`The ${what} ${apiName} is not valid. ${OBJECT_TYPE_RULE}`);

  yield* checkReserved(apiName, what, part);
}

const PROPERTY_RULE =
  'A Property API name starts with a lowercase letter, has only letters and digits, and has 1 to 100 characters.';

export function* checkPropertyApiName(apiName: string, objectType: string): Fallible<void, CompileError> {
  const what = `Property API name of ${objectType}:`;

  yield* checkReserved(apiName, what);

  yield* checkVersionColumn(apiName, columnName(apiName), what);

  if (!/^[a-z][A-Za-z0-9]{0,99}$/.test(apiName))
    return yield new CompileError(`The ${what} ${apiName} is not valid. ${PROPERTY_RULE}`);
}

const ACTION_TYPE_RULE =
  'The part after the API namespace has lowercase letters and digits, in segments that hyphens separate. It has no dot. The full API name has 1 to 100 characters.';

export function* checkActionTypeApiName(apiName: string): Fallible<void, CompileError> {
  const what = 'Action Type API name';

  yield* checkLength(apiName, what, ACTION_TYPE_RULE);

  const part = yield* checkApiNamespace(apiName, what);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part))
    return yield new CompileError(`The ${what} ${apiName} is not valid. ${ACTION_TYPE_RULE}`);

  yield* checkReserved(apiName, what, part);
}

export function* checkOneApiNamespace(apiNames: readonly string[]): Fallible<void, CompileError> {
  const [first] = apiNames;

  if (first === undefined) return;

  const expected = splitApiName(first).namespace;

  for (const apiName of apiNames) {
    const { namespace } = splitApiName(apiName);

    if (namespace !== expected) {
      return yield new CompileError(
        `The API name ${apiName} has the API namespace "${namespace}", and ${first} has "${expected}". The Object Types and Action Types of 1 IR all have the same API namespace.`,
      );
    }
  }
}
