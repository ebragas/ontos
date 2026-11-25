import type { Client } from '@osdk/client';
import { Users, type User } from '@osdk/foundry.admin';
import { ObjectTypesV2, type ObjectPrimaryKeyV2 } from '@osdk/foundry.ontologies';
import { CliError } from '../cliError.ts';
import { errorOutput, failureOf } from '../errors.ts';
import { attempt, caught, type AsyncFallible, type Fallible } from '../fallible.ts';
import { warn, type Io } from '../io.ts';
import type { Flags } from '../main.ts';
import type { Result } from './types.ts';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 10_000;

function* json(
  flags: Flags,
  name: 'where' | 'order-by' | 'select' | 'group-by' | 'parameters',
): Fallible<unknown, CliError> {
  const text = flags[name];

  if (text === undefined) return undefined;

  const parsed = caught((): unknown => JSON.parse(text));

  if (!parsed.ok) return yield new CliError(`--${name} is not JSON: ${text}`);

  return parsed.value;
}

function* pageSize(flags: Flags): Fallible<number, CliError> {
  const text = flags['page-size'];

  if (text === undefined) return DEFAULT_PAGE_SIZE;

  const size = Number(text);

  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE)
    return yield new CliError(`--page-size is a whole number from 1 to ${MAX_PAGE_SIZE}, not ${text}.`);

  return size;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the client loads the type at run time, so no static type exists
type Untyped = any;

const objectType = (apiName: string): Untyped => ({ type: 'object', apiName });
const actionType = (apiName: string): Untyped => ({ type: 'action', apiName });

async function* primaryKeyValue(
  client: Client,
  type: string,
  text: string,
): AsyncFallible<{ property: string; value: string | number }, CliError> {
  const metadata = yield* attempt(() => client.fetchMetadata(objectType(type)), failureOf);
  const { primaryKeyApiName, primaryKeyType } = metadata as { primaryKeyApiName: string; primaryKeyType: string };
  const numeric = ['integer', 'short', 'byte', 'double', 'float'].includes(primaryKeyType);

  return { property: primaryKeyApiName, value: numeric ? Number(text) : text };
}

export async function* objects(
  client: Client,
  type: string,
  primaryKey: string | undefined,
  flags: Flags,
): AsyncFallible<unknown, CliError> {
  const where = yield* json(flags, 'where');

  const options = {
    $pageSize: yield* pageSize(flags),
    ...(flags['page-token'] !== undefined ? { $nextPageToken: flags['page-token'] } : {}),
    ...(flags['order-by'] !== undefined ? { $orderBy: yield* json(flags, 'order-by') } : {}),
    ...(flags.select !== undefined ? { $select: yield* json(flags, 'select') } : {}),
  };

  const set: Untyped = client(objectType(type));

  if (primaryKey === undefined) {
    if (flags.link !== undefined)
      return yield new CliError('--link needs a primary key: ontos objects <ObjectType> <primary key> --link <link>');

    return yield* attempt(() => (where === undefined ? set : set.where(where)).fetchPage(options), failureOf);
  }

  if (flags.link === undefined) {
    const setFlag = (['where', 'order-by', 'page-size', 'page-token'] as const).find(
      (flag) => flags[flag] !== undefined,
    );

    if (setFlag)
      return yield new CliError(
        `ontos objects <ObjectType> <primary key> reads 1 Object, so it does not take --${setFlag}.`,
      );
  }

  const { property, value } = yield* primaryKeyValue(client, type, primaryKey);

  if (flags.link === undefined) {
    const select = flags.select !== undefined ? { $select: yield* json(flags, 'select') } : {};

    return yield* attempt(
      () => set.fetchOne(value, select),
      (error) =>
        error instanceof Error && error.message === 'Expected a single result but got 0 instead'
          ? new CliError(error.message, {
              errorCode: 'NOT_FOUND',
              errorName: 'ObjectNotFound',
              parameters: { objectType: type, primaryKey },
            })
          : failureOf(error),
    );
  }

  const linked: Untyped = set.where({ [property]: { $eq: value } }).pivotTo(flags.link);

  return yield* attempt(() => (where === undefined ? linked : linked.where(where)).fetchPage(options), failureOf);
}

interface AggregateOptions {
  readonly where: unknown;
  readonly select: unknown;
  readonly groupBy: unknown;
}

export function* aggregateOptions(flags: Flags): Fallible<AggregateOptions, CliError> {
  const select = yield* json(flags, 'select');

  if (select === undefined)
    return yield new CliError(
      'Usage: ontos aggregate <ObjectType> --select <JSON> [--group-by <JSON>] [--where <JSON>]',
    );

  if (typeof select !== 'object' || select === null || Array.isArray(select))
    return yield new CliError(
      '--select is a JSON object of <Property>:<metric> keys, such as {"feeDollars:sum":"unordered"}.',
    );

  const bare = Object.keys(select).find((key) => key !== '$count' && !/:[^:]+$/.test(key));

  if (bare !== undefined)
    return yield new CliError(
      `--select key "${bare}" has no metric: write <Property>:<metric>, such as "${bare.replace(/:$/, '')}:sum", or $count.`,
    );

  return { where: yield* json(flags, 'where'), select, groupBy: yield* json(flags, 'group-by') };
}

export async function* aggregate(
  client: Client,
  type: string,
  { where, select, groupBy }: AggregateOptions,
): AsyncFallible<unknown, CliError> {
  const set: Untyped = client(objectType(type));

  return yield* attempt(
    () =>
      (where === undefined ? set : set.where(where)).aggregate({
        $select: select,
        ...(groupBy !== undefined ? { $groupBy: groupBy } : {}),
      }),
    failureOf,
  );
}

export async function* apply(client: Client, type: string, flags: Flags): AsyncFallible<Result, CliError> {
  const parameters = (yield* json(flags, 'parameters')) ?? {};
  const action: Untyped = client(actionType(type));
  const validateOnly = flags['validate-only'] === true;

  const applied = await caught(
    () =>
      action.applyAction(
        parameters,
        validateOnly ? { $validateOnly: true } : { $returnEdits: true },
      ) as Promise<unknown>,
  );

  if (applied.ok) {
    const answer = applied.value;
    const invalid = validateOnly && (answer as { result?: unknown }).result === 'INVALID';

    return { output: answer ?? {}, code: invalid ? 1 : 0 };
  }

  const { error } = applied;

  if (error instanceof Error && error.name === 'ActionValidationError')
    return { output: (error as Error & { validation: unknown }).validation, code: 1 };

  return yield failureOf(error);
}

function userName(user: User): string | undefined {
  return [user.givenName, user.familyName].filter(Boolean).join(' ') || user.email;
}

export async function* history(
  client: Client,
  ontologyRid: string,
  type: string,
  primaryKey: string | undefined,
  flags: Flags,
  io: Pick<Io, 'stderr'>,
): AsyncFallible<unknown, CliError> {
  const objectPrimaryKey: ObjectPrimaryKeyV2 | undefined =
    primaryKey === undefined
      ? undefined
      : { [(yield* primaryKeyValue(client, type, primaryKey)).property]: { type: 'stringValue', value: primaryKey } };

  const page = yield* attempt(
    () =>
      ObjectTypesV2.getEditsHistory(client, ontologyRid, type, {
        ...(objectPrimaryKey ? { objectPrimaryKey } : {}),
        ...(flags['page-token'] !== undefined ? { pageToken: flags['page-token'] } : {}),
      }),
    failureOf,
  );

  const userIds = [...new Set(page.data.map((entry) => entry.userId))];

  if (userIds.length === 0) return page;

  const read = await caught(async (): Promise<Readonly<Record<string, User>>> => {
    const { data: active } = await Users.getBatch(
      client,
      userIds.map((userId) => ({ userId, status: 'ACTIVE' })),
    );

    const rest = userIds.filter((userId) => active[userId] === undefined);

    const former =
      rest.length === 0
        ? {}
        : (
            await Users.getBatch(
              client,
              rest.map((userId) => ({ userId, status: 'DELETED' })),
            )
          ).data;

    return { ...active, ...former };
  });

  if (!read.ok) {
    const { errorName, message } = errorOutput(read.error) as { errorName?: string; message?: string };

    warn(io, `Could not read the names of the users: ${errorName ?? message}`);

    return page;
  }

  const users = read.value;

  return {
    ...page,
    data: page.data.map((entry) => {
      const user = users[entry.userId];

      return user ? { ...entry, user: { name: userName(user), email: user.email } } : entry;
    }),
  };
}
